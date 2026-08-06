// Claims and processes 'generate_cards' jobs — adds AI-generated card(s) to
// an already-extracted stack, either regenerating one card (anchor_card_id
// set, new card inserted immediately after it) or adding more cards (no
// anchor, appended at the end). Never creates a new stack version, unlike
// extract_page/extractWorker.ts — this only ever adds rows to the stack
// that's already there. One Gemini call per job, no audit/repair/polish
// passes (see prompts/generateCards.ts for why those don't fit this job).

import type { SupabaseClient } from '@supabase/supabase-js';
import { callGemini, parseJsonContent } from './gemini.ts';
import { SYSTEM_PROMPT, buildGenerateCardsPrompt, type ExistingCardSummary } from './prompts/generateCards.ts';
import { formatNumberedLines, toSourceLines } from './sourceLines.ts';
import { validatePage } from './blockValidation.ts';
import { loadPagePdfBase64 } from './extractWorker.ts';

export interface GenerateCardsResult {
  claimed: boolean;
  jobId?: string;
  error?: string;
}

type GenerateCardsJobRow = {
  id: string;
  payload: { deck_id: string; stack_id: string; source_page_id: string; instructions: string; anchor_card_id: string | null };
};

type ExistingCardRow = { id: string; order_index: number; title: string | null; component_type: string; source_text: string; content: unknown };

function toSummary(row: ExistingCardRow): ExistingCardSummary {
  return { title: row.title, component_type: row.component_type, source_text: row.source_text, content: row.content };
}

async function processClaimedGenerateCardsJob(supabase: SupabaseClient, job: GenerateCardsJobRow): Promise<GenerateCardsResult> {
  const { deck_id: deckId, stack_id: stackId, source_page_id: pageId, instructions, anchor_card_id: anchorCardId } = job.payload;

  try {
    const { data: page, error: pageError } = await supabase
      .from('import_pages')
      .select('id, text, page_pdf_path, visual_mime_type, image_regions')
      .eq('id', pageId)
      .single();
    if (pageError || !page) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not load source page' });
      return { claimed: true, jobId: job.id, error: 'page_missing' };
    }

    const { data: existingRows, error: existingError } = await supabase
      .from('cards')
      .select('id, order_index, title, component_type, source_text, content')
      .eq('stack_id', stackId)
      .eq('source_page_id', pageId)
      .order('order_index', { ascending: true });
    if (existingError || !existingRows) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not load existing cards' });
      return { claimed: true, jobId: job.id, error: 'existing_cards_missing' };
    }
    const existingCards = existingRows as ExistingCardRow[];

    const anchorRow = anchorCardId ? existingCards.find((c) => c.id === anchorCardId) : undefined;
    if (anchorCardId && !anchorRow) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'anchor card not found in this stack' });
      return { claimed: true, jobId: job.id, error: 'anchor_missing' };
    }

    const { data: tagRows } = await supabase.from('tags').select('name').order('name');
    const existingTags = (tagRows ?? []).map((r) => r.name as string);

    const sourceLines = page.text ? toSourceLines(page.text) : [];
    const pagePdfBase64 = await loadPagePdfBase64(supabase, page.page_pdf_path as string | null);
    const visualMimeType = (page.visual_mime_type as string | null) ?? 'application/pdf';
    const imageRegions = Array.isArray(page.image_regions) ? page.image_regions : [];

    const userPrompt = buildGenerateCardsPrompt({
      instructions,
      numberedSourceLines: sourceLines.length ? formatNumberedLines(sourceLines) : null,
      imageRegions,
      existingCards: existingCards.map(toSummary),
      anchorCard: anchorRow ? toSummary(anchorRow) : null,
      existingTags,
    });

    const outcome = await callGemini({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      inlineData: pagePdfBase64 ? [{ mimeType: visualMimeType, base64: pagePdfBase64 }] : undefined,
    });
    if (!outcome.ok) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: outcome.error });
      return { claimed: true, jobId: job.id, error: outcome.error };
    }

    const parsed = parseJsonContent(outcome.content);
    if (!parsed.ok) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: parsed.error });
      return { claimed: true, jobId: job.id, error: parsed.error };
    }
    const validated = validatePage(parsed.value);
    if (!validated.ok || !validated.value) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: validated.error ?? 'invalid response shape' });
      return { claimed: true, jobId: job.id, error: validated.error };
    }
    const newBlocks = validated.value.blocks;

    // Insert-after mode: shift every existing card after the anchor's
    // order_index by the number of new cards first, then insert the new
    // ones starting right after the anchor — cheaper and race-safer than a
    // full-list client-side renumber, and it's done here, server-side,
    // before the client ever sees the result.
    let baseOrderIndex: number;
    if (anchorRow) {
      const shifted = existingCards.filter((c) => c.order_index > anchorRow.order_index);
      for (const row of shifted) {
        const { error: shiftError } = await supabase
          .from('cards')
          .update({ order_index: row.order_index + newBlocks.length })
          .eq('id', row.id);
        if (shiftError) {
          await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not shift existing card order' });
          return { claimed: true, jobId: job.id, error: 'reorder_failed' };
        }
      }
      baseOrderIndex = anchorRow.order_index + 1;
    } else {
      baseOrderIndex = existingCards.length ? Math.max(...existingCards.map((c) => c.order_index)) + 1 : 0;
    }

    const { data: insertedRows, error: insertError } = await supabase
      .from('cards')
      .insert(
        newBlocks.map((b, i) => ({
          stack_id: stackId,
          source_page_id: pageId,
          deck_id: deckId,
          origin: 'textbook_extraction',
          order_index: baseOrderIndex + i,
          block_kind: b.kind,
          component_type: b.component_type,
          section_number: b.section_number,
          title: b.title,
          instruction: b.instruction,
          source_line_ids: b.source_line_ids,
          source_text: b.source_text,
          content: b.content,
          translation: b.translation,
          category: b.category,
          tags: b.tags,
          needs_review: b.needs_review,
          review_reason: b.review_reason,
          answer_key_status: b.answer_key_status,
          prompt_generated: true,
          include_in_practice: false,
        })),
      )
      .select('id');
    if (insertError || !insertedRows) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not store generated cards' });
      return { claimed: true, jobId: job.id, error: 'write_failed' };
    }

    const newTags = [...new Set(newBlocks.flatMap((b) => b.tags))].filter((t) => !existingTags.includes(t));
    if (newTags.length) {
      await supabase.from('tags').upsert(
        newTags.map((name) => ({ name })),
        { onConflict: 'name', ignoreDuplicates: true },
      );
    }

    await supabase.rpc('complete_job', {
      p_job_id: job.id,
      p_result: { new_card_ids: insertedRows.map((r) => r.id as string), cards_written: insertedRows.length },
    });

    return { claimed: true, jobId: job.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // supabase-js's query/RPC builder is a "thenable" (implements .then
    // only), not a real Promise — .catch() chained directly on it throws
    // "not a function" instead of swallowing the error. Verified directly
    // against real data in syncDeckWorker.ts: this exact pattern silently
    // killed error reporting, leaving jobs stuck in 'processing' forever
    // with no error ever recorded. A real try/catch is the only safe way
    // to make this best-effort.
    try {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: `unhandled: ${message}`.slice(0, 2000) });
    } catch {
      // best-effort
    }
    return { claimed: true, jobId: job.id, error: message };
  }
}

/** Claims up to `batchSize` generate_cards jobs and processes them concurrently — each is fully independent (own stack, own Gemini call), same reasoning as processExtractionJobsBatch in extractWorker.ts. */
export async function processGenerateCardsJobsBatch(supabase: SupabaseClient, batchSize: number): Promise<GenerateCardsResult[]> {
  const { data: claimed, error: claimError } = await supabase.rpc('claim_jobs', { p_type: 'generate_cards', p_limit: batchSize });
  if (claimError) return [{ claimed: false, error: claimError.message }];
  if (!claimed || claimed.length === 0) return [];
  return Promise.all((claimed as GenerateCardsJobRow[]).map((job) => processClaimedGenerateCardsJob(supabase, job)));
}
