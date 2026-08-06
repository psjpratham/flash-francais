import { supabase } from './supabase';
import type { CardWithNote, ImportPage, PageBlock, PageBlockUpdate, PageExtraction } from '../types';

const JOB_TYPE = 'extract_page';

// A remote Edge Function invocation can be killed by the platform's
// execution-time limit (or a dropped client connection) after claim_jobs
// already flipped a row to 'processing' but before complete_job/fail_job
// ever ran, orphaning it forever with no error recorded. Real successful
// Real successful extraction calls observed so far complete in well under a
// minute; this is a generous multiple of that, so a 'processing' row older
// than this is treated as stale rather than "still legitimately running".
export const STALE_AFTER_MS = 5 * 60 * 1000;

export interface ExtractionProgress {
  queued: number;
  processing: number;
  /** Subset of `processing` whose claim is older than STALE_AFTER_MS — never double-counted against `processing`. */
  stale: number;
  completed: number;
  failed: number;
  total: number;
}

interface JobRow {
  id: string;
  status: string;
  payload: { page_id: string; admin_instructions?: string | null };
  result: {
    page_extraction_id?: string;
    version?: number;
    blocks_written?: number;
    model?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
    latency_ms?: number;
    unresolved_warning_count?: number;
    repair_attempts?: number;
  } | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  attempt_count: number;
}

/** Full per-job detail for the admin diagnostics table — never exposed in the plain user-facing progress bar. */
export interface ExtractionJobDetail {
  id: string;
  pageId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  isStale: boolean;
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  blocksWritten: number | null;
  unresolvedWarningCount: number | null;
  repairAttempts: number | null;
  error: string | null;
}

function isRowStale(row: Pick<JobRow, 'status' | 'started_at' | 'created_at'>): boolean {
  if (row.status !== 'processing') return false;
  const claimedAt = new Date(row.started_at ?? row.created_at).getTime();
  return Date.now() - claimedAt > STALE_AFTER_MS;
}

function toJobDetail(row: JobRow): ExtractionJobDetail {
  const startedMs = row.started_at ? new Date(row.started_at).getTime() : null;
  const completedMs = row.completed_at ? new Date(row.completed_at).getTime() : null;
  const createdMs = new Date(row.created_at).getTime();
  const elapsedMs = completedMs != null ? completedMs - (startedMs ?? createdMs) : startedMs != null ? Date.now() - startedMs : null;
  return {
    id: row.id,
    pageId: row.payload.page_id,
    status: row.status as ExtractionJobDetail['status'],
    isStale: isRowStale(row),
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    elapsedMs,
    model: row.result?.model ?? null,
    promptTokens: row.result?.usage?.promptTokens ?? null,
    completionTokens: row.result?.usage?.completionTokens ?? null,
    latencyMs: row.result?.latency_ms ?? null,
    blocksWritten: row.result?.blocks_written ?? null,
    unresolvedWarningCount: row.result?.unresolved_warning_count ?? null,
    repairAttempts: row.result?.repair_attempts ?? null,
    error: row.error,
  };
}

/**
 * Creates one extraction job per usable page — one with extracted text, or
 * an image-only page with a page-PDF slice the model can read directly —
 * never two pages in one job, never a job for a truly unreadable page.
 * Idempotent: if any extract_page jobs already exist for this import, does
 * nothing and reports 0 created.
 */
export async function triggerPageExtraction(importId: string, deckId: string, pages: ImportPage[]): Promise<{ created: number }> {
  const { data: existing, error: existingError } = await supabase
    .from('jobs')
    .select('id')
    .eq('type', JOB_TYPE)
    .in(
      'payload->>page_id',
      pages.map((p) => p.id),
    )
    .limit(1);
  if (existingError) throw existingError;
  if (existing.length > 0) return { created: 0 };

  const extractable = pages.filter((p) => (p.extraction_status === 'extracted' && p.text) || p.extraction_status === 'image_only');
  if (!extractable.length) throw new Error('No pages with extracted text or a page image to process — run preprocessing first.');

  const rows = extractable.map((p) => ({
    type: JOB_TYPE,
    deck_id: deckId,
    payload: { import_id: importId, page_id: p.id },
  }));
  const { error: insertError } = await supabase.from('jobs').insert(rows);
  if (insertError) throw insertError;
  return { created: rows.length };
}

async function fetchJobRows(importId: string): Promise<JobRow[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, status, payload, result, error, created_at, started_at, completed_at, attempt_count')
    .eq('type', JOB_TYPE)
    .eq('payload->>import_id', importId);
  if (error) throw error;
  return data as unknown as JobRow[];
}

/**
 * requeuePageExtraction inserts a fresh job row per retry rather than
 * reusing the old one (that old row is kept, at whatever terminal status it
 * ended at, as a genuine attempt-history record) — so a page can have
 * several job rows over time. Only the most recent one per page reflects
 * that page's current state; an old 'failed' row from before a successful
 * retry must never be counted again.
 */
function latestJobPerPage(rows: JobRow[]): JobRow[] {
  const latestByPage = new Map<string, JobRow>();
  for (const row of rows) {
    const current = latestByPage.get(row.payload.page_id);
    if (!current || new Date(row.created_at).getTime() > new Date(current.created_at).getTime()) latestByPage.set(row.payload.page_id, row);
  }
  return [...latestByPage.values()];
}

export async function getExtractionProgress(importId: string): Promise<ExtractionProgress> {
  const rows = latestJobPerPage(await fetchJobRows(importId));
  const progress: ExtractionProgress = { queued: 0, processing: 0, stale: 0, completed: 0, failed: 0, total: rows.length };
  for (const row of rows) {
    if (row.status === 'queued') progress.queued++;
    else if (row.status === 'processing') {
      progress.processing++;
      if (isRowStale(row)) progress.stale++;
    } else if (row.status === 'completed') progress.completed++;
    else if (row.status === 'failed') progress.failed++;
  }
  return progress;
}

/** Full per-job detail for every extraction job on this import, ordered by creation — admin diagnostics only. */
export async function listExtractionJobs(importId: string): Promise<ExtractionJobDetail[]> {
  const rows = await fetchJobRows(importId);
  return rows.map(toJobDetail).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Resets this import's failed extraction jobs back to queued, so they get picked up again. Returns how many. */
export async function retryFailedExtractionJobs(importId: string): Promise<number> {
  const { data, error } = await supabase
    .from('jobs')
    .update({ status: 'queued', error: null })
    .eq('type', JOB_TYPE)
    .eq('payload->>import_id', importId)
    .eq('status', 'failed')
    .select('id');
  if (error) throw error;
  return data.length;
}

/** Resets exactly one failed job back to queued — never touches any other job, completed or otherwise. */
export async function retryOneExtractionJob(jobId: string): Promise<void> {
  const { error } = await supabase.from('jobs').update({ status: 'queued', error: null }).eq('id', jobId).eq('status', 'failed');
  if (error) throw error;
}

/** Queues a fresh re-extraction of one page (a new page_extractions version), optionally with admin guidance for the repair/extraction prompt. Never touches other pages. Returns the new job's id so a caller can poll it. */
export async function requeuePageExtraction(importId: string, deckId: string, pageId: string, adminInstructions?: string): Promise<string> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      type: JOB_TYPE,
      deck_id: deckId,
      payload: { import_id: importId, page_id: pageId, admin_instructions: adminInstructions ?? null },
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

const GENERATE_CARDS_JOB_TYPE = 'generate_cards';

/**
 * Queues an AI card-generation job scoped to one page's stack — either
 * "regenerate this card" (anchorCardId set: the new card lands immediately
 * after it, original untouched) or "add more cards" (anchorCardId null: new
 * cards land at the end). Never a new stack version, unlike
 * requeuePageExtraction — this only ever adds cards to the existing one.
 */
export async function queueGenerateCardsJob(
  deckId: string,
  stackId: string,
  sourcePageId: string,
  instructions: string,
  anchorCardId: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      type: GENERATE_CARDS_JOB_TYPE,
      deck_id: deckId,
      payload: { deck_id: deckId, stack_id: stackId, source_page_id: sourcePageId, instructions, anchor_card_id: anchorCardId },
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/** Deletes one stack version (e.g. the version left behind after a whole-page re-extraction) — cascades to every card that belonged to it. Never touches the import or any other version. */
export async function deleteStackVersion(stackId: string): Promise<void> {
  const { error } = await supabase.from('stacks').delete().eq('id', stackId);
  if (error) throw error;
}

export interface ActiveCardJob {
  id: string;
  type: 'extract_page' | 'generate_cards';
  status: 'queued' | 'processing';
  payload: Record<string, unknown>;
}

/**
 * Whether a re-extraction or card-generation job is still queued/processing
 * for this page — checked fresh from the DB on every page-review load, never
 * trusted to an in-memory flag. Without this, navigating away mid-job (or
 * just refreshing the tab) and coming back would show no loader at all with
 * no way to tell whether the job is still running, already finished, or
 * failed — the same "never assumes a browser drove any of this" principle
 * importProgress.ts already follows for the whole-import progress bar.
 */
export async function findActiveJobForPage(pageId: string): Promise<ActiveCardJob | null> {
  const [extractResult, generateResult] = await Promise.all([
    supabase.from('jobs').select('id, type, status, payload, created_at').eq('type', JOB_TYPE).eq('payload->>page_id', pageId).in('status', ['queued', 'processing']).order('created_at', { ascending: false }).limit(1),
    supabase
      .from('jobs')
      .select('id, type, status, payload, created_at')
      .eq('type', GENERATE_CARDS_JOB_TYPE)
      .eq('payload->>source_page_id', pageId)
      .in('status', ['queued', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1),
  ]);
  if (extractResult.error) throw extractResult.error;
  if (generateResult.error) throw generateResult.error;
  const candidates = [...(extractResult.data ?? []), ...(generateResult.data ?? [])];
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const top = candidates[0];
  return { id: top.id, type: top.type as ActiveCardJob['type'], status: top.status as ActiveCardJob['status'], payload: top.payload };
}

/**
 * Requeues extraction jobs orphaned in 'processing' beyond STALE_AFTER_MS —
 * the only recovery path for a job whose Edge Function invocation was
 * killed mid-flight. Never touches a job younger than the threshold.
 */
export async function requeueStaleExtractionJobs(importId: string): Promise<number> {
  const thresholdISO = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .update({ status: 'queued', started_at: null })
    .eq('type', JOB_TYPE)
    .eq('payload->>import_id', importId)
    .eq('status', 'processing')
    .or(`started_at.lt.${thresholdISO},and(started_at.is.null,created_at.lt.${thresholdISO})`)
    .select('id');
  if (error) throw error;
  return data.length;
}

// ---------- page_extractions / page_blocks read + review actions ----------

/** The current (max-version) extraction for a page, or null if it hasn't been extracted yet. */
/**
 * The current (max-version) extraction for a page, or null if it hasn't
 * been extracted yet. A page whose cards live entirely in an import-wide
 * merged 'custom' stack (a prompt-only or image-source import) has no
 * kind='page' extraction-attempt stack of its own to find here — verified
 * directly against real cloned decks, where clone-public-deck only copies
 * stacks actually referenced by a card, silently dropping this page's own
 * (0-card) bookkeeping stack. Falls back to the import's shared merged
 * stack so Manage still has something real to show instead of treating an
 * already-extracted, card-bearing page as if it were never extracted.
 * Callers that might delete "the old version" (doReExtract in
 * pageReview.ts) must never treat this fallback stack as safe to delete —
 * it holds every other page's cards too, not just this one's — see the
 * kind==='page' guards there.
 */
export async function getCurrentPageExtraction(pageId: string): Promise<PageExtraction | null> {
  const { data, error } = await supabase
    .from('stacks')
    .select('*')
    .eq('source_page_id', pageId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: page, error: pageError } = await supabase.from('import_pages').select('import_id').eq('id', pageId).maybeSingle();
  if (pageError || !page) return null;
  const { data: imp, error: impError } = await supabase.from('imports').select('merged_stack_id').eq('id', page.import_id).maybeSingle();
  if (impError || !imp?.merged_stack_id) return null;
  const { data: mergedStack, error: mergedError } = await supabase.from('stacks').select('*').eq('id', imp.merged_stack_id).maybeSingle();
  if (mergedError) throw mergedError;
  return mergedStack;
}

export async function listPageBlocks(pageExtractionId: string): Promise<PageBlock[]> {
  const { data, error } = await supabase
    .from('cards')
    .select('*')
    .eq('stack_id', pageExtractionId)
    .order('order_index', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Every card belonging to one specific page, found by its durable
 * `source_page_id` rather than by whichever stack currently claims them.
 * This is what Manage/edit (pageReview.ts) uses instead of listPageBlocks —
 * a merged import files a page's cards under a shared stack (see
 * extractWorker.ts), so "this page's stack" and "the stack these cards
 * currently live in" can differ; source_page_id never changes regardless,
 * so it's the only reliable way to find "this page's cards" for editing.
 */
export async function listCardsForSourcePage(pageId: string): Promise<PageBlock[]> {
  const { data, error } = await supabase.from('cards').select('*').eq('source_page_id', pageId).order('order_index', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Every card across several stacks, each carrying its own source image path
 * — Study mode's data source when more than one stack is selected. Cards
 * come back grouped by stack in the same order stackIds was given (the
 * Stacks browser's own display order), then by order_index within each
 * stack, so a multi-stack study walk reads in the same order as the browser
 * showed them. An optional tag filter narrows within that same selection —
 * Study's equivalent of the old deck-wide tag filter, scoped to what was
 * actually selected rather than the whole deck.
 */
export async function listCardsForStacks(stackIds: string[], tags?: string[]): Promise<CardWithNote[]> {
  if (!stackIds.length) return [];
  let query = supabase
    .from('cards')
    .select('*,import_pages(rendered_page_path)')
    .in('stack_id', stackIds)
    .order('order_index', { ascending: true });
  if (tags?.length) query = query.overlaps('tags', tags);
  const { data, error } = await query;
  if (error) throw error;

  const orderOf = new Map(stackIds.map((id, i) => [id, i]));
  return [...(data as CardWithNote[])].sort((a, b) => {
    const stackOrder = (orderOf.get(a.stack_id) ?? 0) - (orderOf.get(b.stack_id) ?? 0);
    return stackOrder !== 0 ? stackOrder : a.order_index - b.order_index;
  });
}

export async function updatePageBlock(blockId: string, patch: PageBlockUpdate): Promise<PageBlock> {
  const { data, error } = await supabase.from('cards').update(patch).eq('id', blockId).select().single();
  if (error) throw error;
  return data;
}

export async function deletePageBlock(blockId: string): Promise<void> {
  const { error } = await supabase.from('cards').delete().eq('id', blockId);
  if (error) throw error;
}

/**
 * Inserts a new manually-added block at the given order_index — callers are
 * responsible for shifting other blocks' order_index first if inserting
 * mid-page. `stack_id` is whichever stack this page's OTHER cards currently
 * live in (its own per-page stack normally, or the shared merged stack if
 * this import was merged) — callers derive it from an existing sibling
 * card rather than assuming it always equals the page's own stack.
 */
export async function insertPageBlock(block: {
  stack_id: string;
  page_id: string;
  deck_id: string;
  order_index: number;
  kind: NonNullable<PageBlock['block_kind']>;
  component_type: string;
  content: PageBlock['content'];
}): Promise<PageBlock> {
  const { data, error } = await supabase
    .from('cards')
    .insert({
      stack_id: block.stack_id,
      source_page_id: block.page_id,
      deck_id: block.deck_id,
      order_index: block.order_index,
      origin: 'textbook_extraction',
      block_kind: block.kind,
      component_type: block.component_type,
      content: block.content,
      source_line_ids: [],
      source_text: '',
      needs_review: true,
      review_reason: 'manually added during review',
      include_in_practice: false,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function reorderPageBlocks(updates: { id: string; order_index: number }[]): Promise<void> {
  for (const u of updates) {
    const { error } = await supabase.from('cards').update({ order_index: u.order_index }).eq('id', u.id);
    if (error) throw error;
  }
}

// ---------- sending reviewed blocks to practice ----------

/** How many of a page's current blocks are already marked for practice (for the review UI's "N/M sent" state). */
export async function countBlocksSentToPractice(pageBlockIds: string[]): Promise<number> {
  if (!pageBlockIds.length) return 0;
  const { count, error } = await supabase
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .in('id', pageBlockIds)
    .eq('include_in_practice', true);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Toggles one card's practice inclusion. Resets it to a fresh 'new' FSRS
 * card only when flipping OFF -> ON (matching sendPageBlocksToPractice's
 * bulk behavior) — flipping ON -> ON (or any OFF) never touches FSRS state,
 * so a card the student has already studied never loses progress from a
 * stray re-check.
 */
export async function setCardIncludeInPractice(blockId: string, include: boolean, wasIncluded: boolean): Promise<PageBlock> {
  const patch: PageBlockUpdate =
    include && !wasIncluded ? { include_in_practice: true, state: 'new', due: new Date().toISOString() } : { include_in_practice: include };
  const { data, error } = await supabase.from('cards').update(patch).eq('id', blockId).select().single();
  if (error) throw error;
  return data;
}

/** Persists one interactive card's in-progress Study mode answer (see captureAnswerState in readModeRenderers.ts) — best-effort, fire-and-forget from the caller's point of view; a save failure just means that keystroke isn't backed up yet, never a blocking error for the learner. */
export async function updateCardStudyAnswer(blockId: string, state: Record<string, unknown> | null): Promise<void> {
  const { error } = await supabase.from('cards').update({ study_answer: state }).eq('id', blockId);
  if (error) throw error;
}

/** Wipes saved Study-mode answers for a set of cards — the "clear before studying" option offered at the start of a Study session. */
export async function clearStudyAnswersForCards(cardIds: string[]): Promise<void> {
  if (!cardIds.length) return;
  const { error } = await supabase.from('cards').update({ study_answer: null }).in('id', cardIds);
  if (error) throw error;
}

export type SourceVisibilityField = 'show_source_in_practice' | 'show_source_in_study';

/** Per-card choice: whether Practice or Study mode shows this card's source image alongside it — independent of include_in_practice, and independent of the other mode's own toggle (see show_source_in_practice / show_source_in_study on PageBlock). */
export async function setCardShowSource(blockId: string, field: SourceVisibilityField, show: boolean): Promise<PageBlock> {
  const patch = field === 'show_source_in_practice' ? { show_source_in_practice: show } : { show_source_in_study: show };
  const { data, error } = await supabase.from('cards').update(patch).eq('id', blockId).select().single();
  if (error) throw error;
  return data;
}

/**
 * Marks a page's current blocks (in their current, admin-reordered
 * order_index) as included in practice — skipping any block that's already
 * marked, so a card the student has already studied never has its FSRS
 * progress reset by a second click after adding/reordering blocks on an
 * already-sent page.
 */
export async function sendPageBlocksToPractice(pageId: string): Promise<{ sent: number; alreadySent: number }> {
  const { data: blocks, error: blocksError } = await supabase
    .from('cards')
    .select('id, include_in_practice')
    .eq('source_page_id', pageId)
    .order('order_index', { ascending: true });
  if (blocksError) throw blocksError;
  if (!blocks?.length) return { sent: 0, alreadySent: 0 };

  const toSend = blocks.filter((b) => !b.include_in_practice);
  if (!toSend.length) return { sent: 0, alreadySent: blocks.length };

  const { error: updateError } = await supabase
    .from('cards')
    .update({ include_in_practice: true, state: 'new', due: new Date().toISOString() })
    .in(
      'id',
      toSend.map((b) => b.id),
    );
  if (updateError) throw updateError;

  return { sent: toSend.length, alreadySent: blocks.length - toSend.length };
}

/** Bulk version of setCardShowSource — sets the given field for every one of a page's current blocks in one shot (the "Show/Hide source for all" toolbar actions — one pair for Practice, one for Study). Skips blocks already at the target value. */
export async function setPageBlocksShowSource(pageId: string, field: SourceVisibilityField, show: boolean): Promise<{ updated: number }> {
  const { data: blocks, error: blocksError } = await supabase.from('cards').select('id, show_source_in_practice, show_source_in_study').eq('source_page_id', pageId);
  if (blocksError) throw blocksError;
  if (!blocks?.length) return { updated: 0 };

  const toUpdate = blocks.filter((b) => b[field] !== show);
  if (!toUpdate.length) return { updated: 0 };

  const patch = field === 'show_source_in_practice' ? { show_source_in_practice: show } : { show_source_in_study: show };
  const { error: updateError } = await supabase
    .from('cards')
    .update(patch)
    .in(
      'id',
      toUpdate.map((b) => b.id),
    );
  if (updateError) throw updateError;

  return { updated: toUpdate.length };
}

/** The reverse of sendPageBlocksToPractice — pulls this page's cards back out of practice. FSRS scheduling state is left untouched (only include_in_practice flips off), so re-including later just resumes wherever the card's due/state already were. */
export async function removePageBlocksFromPractice(pageId: string): Promise<{ removed: number }> {
  const { data: blocks, error: blocksError } = await supabase.from('cards').select('id, include_in_practice').eq('source_page_id', pageId);
  if (blocksError) throw blocksError;
  if (!blocks?.length) return { removed: 0 };

  const toRemove = blocks.filter((b) => b.include_in_practice);
  if (!toRemove.length) return { removed: 0 };

  const { error: updateError } = await supabase
    .from('cards')
    .update({ include_in_practice: false })
    .in(
      'id',
      toRemove.map((b) => b.id),
    );
  if (updateError) throw updateError;

  return { removed: toRemove.length };
}

/** Whether this import has any page extraction yet — used to surface "Review pages" as soon as one page finishes. */
export async function hasAnyPageExtractions(importId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('stacks')
    .select('id, import_pages!inner(import_id)', { count: 'exact', head: true })
    .eq('import_pages.import_id', importId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export interface PageReviewCounts {
  needsReview: number;
  approved: number;
  failed: number;
  pending: number;
}

/** Per-page review status, counting only each page's current (max-version) extraction — never double-counts a retried page's old versions. */
export async function getPageReviewCounts(importId: string): Promise<PageReviewCounts> {
  const { data, error } = await supabase
    .from('stacks')
    .select('source_page_id, version, status, import_pages!inner(import_id)')
    .eq('import_pages.import_id', importId);
  if (error) throw error;

  const latestByPage = new Map<string, { version: number; status: string }>();
  for (const row of data as unknown as { source_page_id: string; version: number; status: string }[]) {
    const current = latestByPage.get(row.source_page_id);
    if (!current || row.version > current.version) latestByPage.set(row.source_page_id, { version: row.version, status: row.status });
  }

  const counts: PageReviewCounts = { needsReview: 0, approved: 0, failed: 0, pending: 0 };
  for (const { status } of latestByPage.values()) {
    if (status === 'approved') counts.approved++;
    else if (status === 'failed') counts.failed++;
    else if (status === 'needs_review') counts.needsReview++;
    else counts.pending++;
  }
  return counts;
}
