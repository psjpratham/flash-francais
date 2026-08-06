// Claims and processes 'sync_deck' jobs — pulls whatever's new on the deck a
// clone was made from (new cards in existing stacks, new stacks/pages, even
// whole new imports) into the clone, add-only: never updates or deletes an
// existing row, never touches FSRS state, never touches the "Manual cards"
// bucket (origin='manual' is excluded from every query below by
// construction — matching it retroactively has no reliable position/
// identity to key off, see the migration's own comment).
//
// clone-public-deck gives every cloned row a brand-new uuid with no link
// back to what it was copied from — cloned_from_stack_id/cloned_from_card_id
// (added by 20260817000000_deck_sync.sql) are that missing link, populated
// here. A clone with no existing links yet (anything cloned before this
// shipped) gets them established by the RECONCILE PASS below, the first
// time it's synced — matched by page position (import title +
// displayed_page_number, both preserved verbatim by clone-public-deck) and
// order_index/content, not by a separate backfill script. Only rows still
// unmatched after that are genuinely new and get added.
//
// This is deliberately the same shape as clone-public-deck's own deep-copy
// logic (same field lists, same copyStorageObject helper) — sync is really
// "clone-public-deck, scoped to a delta, made add-only." A partial failure
// mid-sync is safe to just retry: every row already added is already
// linked, so a re-run's reconcile pass finds it immediately and never
// re-adds it — no explicit resume logic needed.

import type { SupabaseClient } from '@supabase/supabase-js';
import { copyStorageObject } from './storageCopy.ts';

const BUCKET_RENDERS = 'import-page-renders';
const BUCKET_AUDIO = 'import-audio';

export interface SyncDeckResult {
  claimed: boolean;
  jobId?: string;
  error?: string;
}

type SyncDeckJobRow = { id: string; payload: { deck_id: string } };

// deno-lint-ignore no-explicit-any
type Row = any;

async function selectIn(supabase: SupabaseClient, table: string, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase.from(table).select('*').in('id', ids);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Writes the furthest phase reached straight onto the job row as it goes,
// not just at the end — cheap, and the only way to see how far a run got
// if it dies somewhere unexpected (this Edge Function environment has no
// accessible log tail from this CLI). Worth keeping permanently, not just
// for this session's debugging. Best-effort (never lets a logging write
// itself fail the job).
async function checkpoint(supabase: SupabaseClient, jobId: string, phase: string, extra?: Record<string, unknown>): Promise<void> {
  // supabase-js's query builder is a "thenable" (implements .then only),
  // not a real Promise — .catch()/.finally() chained directly on it throws
  // "not a function" rather than swallowing the error, which is exactly
  // what this best-effort wrapper is trying to avoid. A real try/catch
  // around the awaited call is the only safe way to make this best-effort.
  try {
    await supabase.from('jobs').update({ result: { phase, at: new Date().toISOString(), ...extra } }).eq('id', jobId);
  } catch {
    // best-effort — never lets a logging write fail the job
  }
}

// Verified directly against real data: a run can hang indefinitely with
// zero error ever recorded, past whatever is actually causing it (unclear
// even after fixing several confirmed bugs — batching, a missing-imports
// gap). Rather than let that keep orphaning jobs silently, race the real
// work against a hard deadline — whichever settles first wins. A timeout
// still leaves the job clearly failed (with the last checkpoint reached
// intact on its `result`, since fail_job never touches that column) instead
// of stuck in 'processing' forever with nothing to look at.
const JOB_TIMEOUT_MS = 60_000;

async function processClaimedSyncJob(supabase: SupabaseClient, job: SyncDeckJobRow): Promise<SyncDeckResult> {
  const timeout = new Promise<SyncDeckResult>((resolve) => {
    setTimeout(() => {
      // An uncaught exception inside a setTimeout callback doesn't just
      // fail this promise — it crashes the whole Deno event loop (verified
      // directly: the .catch()-isn't-a-function TypeError here previously
      // took down the entire invocation, "shutdown" and all, which is
      // exactly why this "guaranteed" timeout wasn't guaranteed at all).
      void (async () => {
        try {
          await supabase.rpc('fail_job', { p_job_id: job.id, p_error: `timed_out after ${JOB_TIMEOUT_MS}ms — see this job's result field for the last checkpoint reached` });
        } catch {
          // best-effort
        }
        resolve({ claimed: true, jobId: job.id, error: 'timed_out' });
      })();
    }, JOB_TIMEOUT_MS);
  });
  return Promise.race([doSyncWork(supabase, job), timeout]);
}

async function doSyncWork(supabase: SupabaseClient, job: SyncDeckJobRow): Promise<SyncDeckResult> {
  const { deck_id: clonedDeckId } = job.payload;
  const syncId = crypto.randomUUID();
  let stacksAdded = 0;
  let cardsAdded = 0;
  let importsAdded = 0;

  try {
    await checkpoint(supabase, job.id, 'entered');
    const { data: clonedDeck, error: clonedDeckError } = await supabase.from('decks').select('id, user_id, cloned_from_deck_id').eq('id', clonedDeckId).single();
    await checkpoint(supabase, job.id, 'cloned_deck_loaded');
    if (clonedDeckError || !clonedDeck?.cloned_from_deck_id) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'not_a_clone' });
      return { claimed: true, jobId: job.id, error: 'not_a_clone' };
    }
    const originalDeckId = clonedDeck.cloned_from_deck_id as string;
    const cloneOwnerId = clonedDeck.user_id as string;

    const { data: originalDeck } = await supabase.from('decks').select('id').eq('id', originalDeckId).maybeSingle();
    if (!originalDeck) {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'original_deck_deleted' });
      return { claimed: true, jobId: job.id, error: 'original_deck_deleted' };
    }

    // Written up front, as a placeholder, and finalized (counts/status) at
    // the very end — added_by_sync_id on every stack/card the add pass
    // inserts below is a foreign key into this row, so it has to exist
    // BEFORE any of those inserts happen, not just once the whole sync is
    // done.
    const { error: syncRowError } = await supabase.from('deck_syncs').insert({ id: syncId, deck_id: clonedDeckId, status: 'completed', stacks_added: 0, cards_added: 0, imports_added: 0 });
    if (syncRowError) throw new Error(syncRowError.message);

    // ---------- load both decks' textbook-extraction content (Manual cards, origin='manual', excluded by construction) ----------
    const [origCardsRes, cloneCardsRes] = await Promise.all([
      supabase.from('cards').select('*').eq('deck_id', originalDeckId).eq('origin', 'textbook_extraction').order('stack_id').order('order_index'),
      supabase.from('cards').select('*').eq('deck_id', clonedDeckId).eq('origin', 'textbook_extraction').order('stack_id').order('order_index'),
    ]);
    if (origCardsRes.error) throw new Error(origCardsRes.error.message);
    if (cloneCardsRes.error) throw new Error(cloneCardsRes.error.message);
    const origCards: Row[] = origCardsRes.data ?? [];
    const cloneCards: Row[] = cloneCardsRes.data ?? [];

    const origStacks = await selectIn(supabase, 'stacks', [...new Set(origCards.map((c) => c.stack_id))]);
    const cloneStacks = await selectIn(supabase, 'stacks', [...new Set(cloneCards.map((c) => c.stack_id))]);
    // Pages aren't only reachable via a stack — a custom/merged stack's own
    // source_page_id is always null, but its individual CARDS each still
    // carry their own real source_page_id (required by the
    // cards_origin_source_page_consistency check, verified directly
    // against real data), so pages referenced by cards have to be pulled
    // in too, or a custom stack's cards can never be mapped to a real
    // clone page at all.
    const origPages = await selectIn(supabase, 'import_pages', [...new Set([...origStacks.map((s) => s.source_page_id), ...origCards.map((c) => c.source_page_id)].filter(Boolean))]);
    const clonePages = await selectIn(supabase, 'import_pages', [...new Set([...cloneStacks.map((s) => s.source_page_id), ...cloneCards.map((c) => c.source_page_id)].filter(Boolean))]);
    // Imports aren't only reachable via a page — a prompt-only or image-
    // source import's cards live entirely in its merged 'custom' stack
    // (no page of its own contributes it to origPages/clonePages at all),
    // so that import has to be pulled in via merged_stack_id too, or it's
    // silently invisible to every pass below.
    const origCustomStackIds = origStacks.filter((s) => !s.source_page_id).map((s) => s.id);
    const cloneCustomStackIds = cloneStacks.filter((s) => !s.source_page_id).map((s) => s.id);
    const { data: origImportsFromCustomData } = origCustomStackIds.length ? await supabase.from('imports').select('*').in('merged_stack_id', origCustomStackIds) : { data: [] };
    const { data: cloneImportsFromCustomData } = cloneCustomStackIds.length ? await supabase.from('imports').select('*').in('merged_stack_id', cloneCustomStackIds) : { data: [] };
    const origImportsFromPages = await selectIn(supabase, 'imports', [...new Set(origPages.map((p) => p.import_id))]);
    const cloneImportsFromPages = await selectIn(supabase, 'imports', [...new Set(clonePages.map((p) => p.import_id))]);
    const origImports: Row[] = [...new Map([...origImportsFromPages, ...(origImportsFromCustomData ?? [])].map((i) => [i.id, i])).values()];
    const cloneImports: Row[] = [...new Map([...cloneImportsFromPages, ...(cloneImportsFromCustomData ?? [])].map((i) => [i.id, i])).values()];
    const origImportIds = origImports.map((i) => i.id);
    const { data: origAudioData, error: origAudioError } = origImportIds.length
      ? await supabase.from('import_audio_files').select('*').in('import_id', origImportIds)
      : { data: [], error: null };
    if (origAudioError) throw new Error(origAudioError.message);
    const origAudio: Row[] = origAudioData ?? [];

    const origPagesById = new Map(origPages.map((p) => [p.id, p]));
    const clonePagesById = new Map(clonePages.map((p) => [p.id, p]));
    const origCardsByStack = new Map<string, Row[]>();
    for (const c of origCards) origCardsByStack.set(c.stack_id, [...(origCardsByStack.get(c.stack_id) ?? []), c]);
    const cloneCardsByStack = new Map<string, Row[]>();
    for (const c of cloneCards) cloneCardsByStack.set(c.stack_id, [...(cloneCardsByStack.get(c.stack_id) ?? []), c]);

    // origPageId -> clonePageId, matched by (parent import title,
    // displayed_page_number) — same key as stack matching, but at the page
    // level, since a card's own source_page_id has to resolve to a real
    // clone page regardless of whether its stack is a per-page stack or a
    // shared custom one (which has no page of its own to piggyback on).
    const clonePageByTitlePage = new Map<string, Row>();
    for (const p of clonePages) {
      const imp = cloneImports.find((i) => i.id === p.import_id);
      if (imp) clonePageByTitlePage.set(`${imp.title}::${p.displayed_page_number}`, p);
    }
    const origPageToClonePage = new Map<string, string>();
    for (const p of origPages) {
      const imp = origImports.find((i) => i.id === p.import_id);
      if (!imp) continue;
      const candidate = clonePageByTitlePage.get(`${imp.title}::${p.displayed_page_number}`);
      if (candidate) origPageToClonePage.set(p.id, candidate.id);
    }

    /** Resolves an original card's source_page_id to its clone counterpart, copying the page over first (rare — only a genuinely new page added to an already-matched merged-stack import since cloning) if no match exists yet. */
    async function resolveClonePageId(origPageId: string, cloneImportId: string): Promise<string> {
      const existing = origPageToClonePage.get(origPageId);
      if (existing) return existing;
      const origPage = origPagesById.get(origPageId);
      if (!origPage) throw new Error(`sync: original page ${origPageId} not found`);
      let newRenderedPath: string | null = null;
      if (origPage.rendered_page_path) {
        newRenderedPath = `${cloneImportId}/${crypto.randomUUID()}.png`;
        await copyStorageObject(supabase, BUCKET_RENDERS, origPage.rendered_page_path, newRenderedPath, 'image/png');
      }
      const clonePagesForImport = clonePages.filter((p) => p.import_id === cloneImportId);
      const nextPageIndex = clonePagesForImport.length ? Math.max(...clonePagesForImport.map((p) => p.page_index)) + 1 : 0;
      const { data: newPage, error } = await supabase
        .from('import_pages')
        .insert({
          import_id: cloneImportId,
          page_index: nextPageIndex,
          source_type: origPage.source_type,
          filename: origPage.filename,
          displayed_page_number: origPage.displayed_page_number,
          text: origPage.text,
          extraction_status: origPage.extraction_status,
          rendered_page_path: newRenderedPath,
          width: origPage.width,
          height: origPage.height,
          image_regions: origPage.image_regions,
          page_pdf_path: null,
          visual_mime_type: origPage.visual_mime_type,
        })
        .select('*')
        .single();
      if (error || !newPage) throw new Error(error?.message ?? 'page_insert_failed');
      origPageToClonePage.set(origPageId, newPage.id);
      clonePages.push(newPage);
      return newPage.id;
    }

    await checkpoint(supabase, job.id, 'data_loaded', { origCards: origCards.length, cloneCards: cloneCards.length, origStacks: origStacks.length, cloneStacks: cloneStacks.length, origImports: origImports.length, cloneImports: cloneImports.length });

    // ---------- reconcile pass: link existing rows that have no link yet ----------
    const cloneStackByTitlePage = new Map<string, Row>();
    for (const s of cloneStacks) {
      if (!s.source_page_id) continue;
      const page = clonePagesById.get(s.source_page_id);
      const imp = page && cloneImports.find((i) => i.id === page.import_id);
      if (imp) cloneStackByTitlePage.set(`${imp.title}::${page.displayed_page_number}`, s);
    }

    const alreadyLinkedOrigStackIds = new Set(cloneStacks.filter((s) => s.cloned_from_stack_id).map((s) => s.cloned_from_stack_id as string));
    const stackReconcileLinks = new Map<string, string>(); // origStackId -> cloneStackId

    for (const os of origStacks) {
      if (alreadyLinkedOrigStackIds.has(os.id)) continue;
      if (os.source_page_id) {
        const page = origPagesById.get(os.source_page_id);
        const imp = page && origImports.find((i) => i.id === page.import_id);
        if (!imp) continue;
        const candidate = cloneStackByTitlePage.get(`${imp.title}::${page.displayed_page_number}`);
        if (candidate && !candidate.cloned_from_stack_id) stackReconcileLinks.set(os.id, candidate.id);
      } else {
        // Shared/merged 'custom' stack (image-source or prompt-only import)
        // has no page of its own to key off — matched by parent import
        // title instead (exactly one merged stack per import).
        const parentImport = origImports.find((i) => i.merged_stack_id === os.id);
        const candidateImport = parentImport && cloneImports.find((ci) => ci.title === parentImport.title);
        const candidateStack = candidateImport?.merged_stack_id ? cloneStacks.find((cs) => cs.id === candidateImport.merged_stack_id) : undefined;
        if (candidateStack && !candidateStack.cloned_from_stack_id) stackReconcileLinks.set(os.id, candidateStack.id);
      }
    }

    const alreadyLinkedOrigCardIds = new Set(cloneCards.filter((c) => c.cloned_from_card_id).map((c) => c.cloned_from_card_id as string));
    const cardReconcileLinks: { origCardId: string; cloneCardId: string }[] = [];

    for (const [origStackId, cloneStackId] of stackReconcileLinks) {
      const origList = (origCardsByStack.get(origStackId) ?? []).slice().sort((a, b) => a.order_index - b.order_index);
      const cloneList = (cloneCardsByStack.get(cloneStackId) ?? []).slice().sort((a, b) => a.order_index - b.order_index);
      const usedCloneIds = new Set<string>();
      origList.forEach((oc, i) => {
        if (alreadyLinkedOrigCardIds.has(oc.id)) return;
        // Same-position match first (the common case); falls back to a
        // content search within the stack when position doesn't line up
        // (something reordered/added on the clone since). Still unmatched
        // after both means this one card couldn't be confidently linked —
        // it may get re-added once as "new" below, an accepted limitation
        // of a heuristic match rather than a real per-row id.
        const posCandidate = cloneList[i];
        const match =
          posCandidate && !usedCloneIds.has(posCandidate.id) && !posCandidate.cloned_from_card_id && posCandidate.source_text === oc.source_text
            ? posCandidate
            : cloneList.find((cc) => !usedCloneIds.has(cc.id) && !cc.cloned_from_card_id && cc.source_text === oc.source_text);
        if (match) {
          usedCloneIds.add(match.id);
          cardReconcileLinks.push({ origCardId: oc.id, cloneCardId: match.id });
        }
      });
    }

    await checkpoint(supabase, job.id, 'reconcile_links_computed', { stackLinks: stackReconcileLinks.size, cardLinks: cardReconcileLinks.length });

    // One round-trip each via a bulk SQL RPC (see the 20260817010000
    // migration) — verified directly against real data that one UPDATE per
    // row, even with client-side concurrency, was still minutes-slow on a
    // deck with hundreds of already-existing cards.
    if (stackReconcileLinks.size) {
      const { error } = await supabase.rpc('sync_link_stacks', {
        pairs: [...stackReconcileLinks.entries()].map(([origId, cloneId]) => ({ clone_id: cloneId, orig_id: origId })),
      });
      if (error) throw new Error(error.message);
    }
    if (cardReconcileLinks.length) {
      const { error } = await supabase.rpc('sync_link_cards', {
        pairs: cardReconcileLinks.map((l) => ({ clone_id: l.cloneCardId, orig_id: l.origCardId })),
      });
      if (error) throw new Error(error.message);
    }

    await checkpoint(supabase, job.id, 'reconcile_writes_done');

    // ---------- add pass: whatever's still unmatched in the original is genuinely new ----------
    const linkedOrigStackIds = new Set([...alreadyLinkedOrigStackIds, ...stackReconcileLinks.keys()]);
    const linkedOrigCardIds = new Set([...alreadyLinkedOrigCardIds, ...cardReconcileLinks.map((l) => l.origCardId)]);
    const matchedStackPairs: [string, string][] = [
      ...stackReconcileLinks.entries(),
      ...cloneStacks.filter((s) => s.cloned_from_stack_id && !stackReconcileLinks.has(s.cloned_from_stack_id)).map((s): [string, string] => [s.cloned_from_stack_id as string, s.id]),
    ];

    const audioIdMap = new Map<string, string>(); // origAudioId -> cloneAudioId, memoized for the whole job
    async function ensureAudioCopied(origAudioId: string, cloneImportId: string): Promise<string | null> {
      if (audioIdMap.has(origAudioId)) return audioIdMap.get(origAudioId)!;
      const a = origAudio.find((r: Row) => r.id === origAudioId);
      if (!a) return null;
      const newPath = `${cloneImportId}/${crypto.randomUUID()}-${a.normalized_filename}`;
      await copyStorageObject(supabase, BUCKET_AUDIO, a.storage_path, newPath);
      const { data: newAudio, error } = await supabase
        .from('import_audio_files')
        .insert({ import_id: cloneImportId, original_filename: a.original_filename, normalized_filename: a.normalized_filename, track_number: a.track_number, storage_path: newPath, duration: a.duration })
        .select('id')
        .single();
      if (error || !newAudio) throw new Error(error?.message ?? 'audio_insert_failed');
      audioIdMap.set(origAudioId, newAudio.id);
      return newAudio.id;
    }

    async function remapAudioInContent(content: Row, cloneImportId: string): Promise<Row> {
      if (content && typeof content === 'object' && content.matchedAudioAssetId) {
        return { ...content, matchedAudioAssetId: await ensureAudioCopied(content.matchedAudioAssetId, cloneImportId) };
      }
      return content;
    }

    // Collected here, then flushed in bulk (see flushPendingCards) instead
    // of one insert per card — same reasoning as the reconcile writes
    // above: a large first sync can mean hundreds of new cards, and one
    // round-trip per row was what actually caused the timeout verified
    // against real data.
    const pendingCardRows: Row[] = [];

    async function queueCard(c: Row, cloneStackId: string, clonePageId: string | null, orderIndex: number, cloneImportId: string | null): Promise<void> {
      const content = cloneImportId ? await remapAudioInContent(c.content, cloneImportId) : c.content;
      pendingCardRows.push({
        stack_id: cloneStackId,
        deck_id: clonedDeckId,
        order_index: orderIndex,
        origin: 'textbook_extraction',
        source_page_id: clonePageId,
        block_kind: c.block_kind,
        component_type: c.component_type,
        section_number: c.section_number,
        title: c.title,
        instruction: c.instruction,
        language: c.language,
        source_line_ids: c.source_line_ids,
        source_text: c.source_text,
        content,
        translation: c.translation,
        category: c.category,
        answer_key_status: c.answer_key_status,
        prompt_generated: c.prompt_generated,
        pronunciation_enabled: c.pronunciation_enabled,
        activity_audio_reference: c.activity_audio_reference,
        needs_review: c.needs_review,
        review_reason: c.review_reason,
        show_source_in_practice: c.show_source_in_practice,
        show_source_in_study: c.show_source_in_study,
        tags: c.tags,
        include_in_practice: c.include_in_practice,
        cloned_from_card_id: c.id,
        added_by_sync_id: syncId,
      });
    }

    /** One bulk insert per chunk (Postgrest handles a few hundred rows per request comfortably; chunked defensively for a genuinely huge first sync). */
    async function flushPendingCards(): Promise<void> {
      const CHUNK = 300;
      for (let i = 0; i < pendingCardRows.length; i += CHUNK) {
        const chunk = pendingCardRows.slice(i, i + CHUNK);
        const { error } = await supabase.from('cards').insert(chunk);
        if (error) throw new Error(error.message);
        cardsAdded += chunk.length;
      }
    }

    // ---- 1. new cards within an already-matched stack ----
    for (const [origStackId, cloneStackId] of matchedStackPairs) {
      const newOnesHere = (origCardsByStack.get(origStackId) ?? []).filter((c) => !linkedOrigCardIds.has(c.id));
      if (!newOnesHere.length) continue;
      const cloneStackRow = cloneStacks.find((s) => s.id === cloneStackId);
      // Which clone import new pages/audio for this stack's cards should
      // file under: directly via the stack's own page for a per-page
      // stack, or via the shared merged-stack -> import link for a custom
      // stack (which has no page of its own).
      const cloneImportIdForStack = cloneStackRow?.source_page_id
        ? ((clonePagesById.get(cloneStackRow.source_page_id)?.import_id as string | undefined) ?? null)
        : (cloneImports.find((i) => i.merged_stack_id === cloneStackId)?.id ?? null);
      const existingInClone = cloneCardsByStack.get(cloneStackId) ?? [];
      let nextOrderIndex = existingInClone.length ? Math.max(...existingInClone.map((c) => c.order_index)) + 1 : 0;
      for (const oc of newOnesHere) {
        // Every origin='textbook_extraction' card needs its own real
        // source_page_id (cards_origin_source_page_consistency) — the
        // stack's own page is null for a custom/merged stack, so each
        // card's OWN source_page_id has to be resolved individually,
        // never inherited from the stack.
        const clonePageId = oc.source_page_id && cloneImportIdForStack ? await resolveClonePageId(oc.source_page_id, cloneImportIdForStack) : null;
        await queueCard(oc, cloneStackId, clonePageId, nextOrderIndex++, cloneImportIdForStack);
      }
    }

    await checkpoint(supabase, job.id, 'case1_done', { pendingCardRows: pendingCardRows.length });

    // ---- 2 & 3. whole new stacks (pages), split by whether their import already exists in the clone ----
    const newStacks = origStacks.filter((s) => !linkedOrigStackIds.has(s.id));
    const cloneImportByTitle = new Map(cloneImports.map((i) => [i.title, i]));

    const newPagesInExistingImports: Row[] = [];
    const newWholeImportIds = new Set<string>();
    for (const os of newStacks) {
      if (os.source_page_id) {
        const page = origPagesById.get(os.source_page_id);
        const imp = page && origImports.find((i) => i.id === page.import_id);
        if (!page || !imp) continue;
        if (cloneImportByTitle.has(imp.title)) newPagesInExistingImports.push({ page, stack: os, importId: imp.id });
        else newWholeImportIds.add(imp.id);
      } else {
        const parentImport = origImports.find((i) => i.merged_stack_id === os.id);
        if (parentImport && !cloneImportByTitle.has(parentImport.title)) newWholeImportIds.add(parentImport.id);
      }
    }

    await checkpoint(supabase, job.id, 'classification_done', { newStacks: newStacks.length, newPagesInExistingImports: newPagesInExistingImports.length, newWholeImportIds: newWholeImportIds.size });

    // ---- 2. new page within an already-matched import ----
    for (const { page, stack, importId } of newPagesInExistingImports) {
      const cloneImport = cloneImportByTitle.get(origImports.find((i) => i.id === importId)!.title)!;
      const clonePagesForImport = clonePages.filter((p) => p.import_id === cloneImport.id);
      const nextPageIndex = clonePagesForImport.length ? Math.max(...clonePagesForImport.map((p) => p.page_index)) + 1 : 0;

      let newRenderedPath: string | null = null;
      if (page.rendered_page_path) {
        newRenderedPath = `${cloneImport.id}/${crypto.randomUUID()}.png`;
        await copyStorageObject(supabase, BUCKET_RENDERS, page.rendered_page_path, newRenderedPath, 'image/png');
      }
      const { data: newPage, error: newPageError } = await supabase
        .from('import_pages')
        .insert({
          import_id: cloneImport.id,
          page_index: nextPageIndex,
          source_type: page.source_type,
          filename: page.filename,
          displayed_page_number: page.displayed_page_number,
          text: page.text,
          extraction_status: page.extraction_status,
          rendered_page_path: newRenderedPath,
          width: page.width,
          height: page.height,
          image_regions: page.image_regions,
          page_pdf_path: null,
          visual_mime_type: page.visual_mime_type,
        })
        .select('id')
        .single();
      if (newPageError || !newPage) throw new Error(newPageError?.message ?? 'page_insert_failed');

      const { data: newStack, error: newStackError } = await supabase
        .from('stacks')
        .insert({
          deck_id: clonedDeckId,
          name: stack.name,
          kind: stack.kind,
          source_page_id: newPage.id,
          version: 1,
          status: stack.status,
          model: stack.model,
          prompt_version: stack.prompt_version,
          approved_with_warnings: stack.approved_with_warnings,
          approval_override_reason: stack.approval_override_reason,
          cloned_from_stack_id: stack.id,
          added_by_sync_id: syncId,
        })
        .select('id')
        .single();
      if (newStackError || !newStack) throw new Error(newStackError?.message ?? 'stack_insert_failed');
      stacksAdded++;

      const cardsForStack = (origCardsByStack.get(stack.id) ?? []).slice().sort((a, b) => a.order_index - b.order_index);
      let orderIndex = 0;
      for (const c of cardsForStack) await queueCard(c, newStack.id, newPage.id, orderIndex++, cloneImport.id);
    }

    await checkpoint(supabase, job.id, 'case2_done', { stacksAdded, pendingCardRows: pendingCardRows.length });

    // ---- 3. whole new imports ----
    for (const origImportId of newWholeImportIds) {
      const origImport = origImports.find((i) => i.id === origImportId)!;
      const pagesForImport = origPages.filter((p) => p.import_id === origImportId).sort((a, b) => a.page_index - b.page_index);

      const { data: newImportRow, error: newImportError } = await supabase
        .from('imports')
        .insert({
          user_id: cloneOwnerId,
          deck_id: clonedDeckId,
          title: origImport.title,
          status: 'completed',
          total_pages: pagesForImport.length,
          pages_discovered: pagesForImport.length,
          pages_prepared: pagesForImport.length,
          force_image_only: origImport.force_image_only,
          custom_prompt: origImport.custom_prompt,
        })
        .select('id')
        .single();
      if (newImportError || !newImportRow) throw new Error(newImportError?.message ?? 'import_insert_failed');
      importsAdded++;

      const pageIdMap = new Map<string, string>();
      let pageIndexCounter = 0;
      for (const p of pagesForImport) {
        let newRenderedPath: string | null = null;
        if (p.rendered_page_path) {
          newRenderedPath = `${newImportRow.id}/${crypto.randomUUID()}.png`;
          await copyStorageObject(supabase, BUCKET_RENDERS, p.rendered_page_path, newRenderedPath, 'image/png');
        }
        const { data: newPage, error: newPageError } = await supabase
          .from('import_pages')
          .insert({
            import_id: newImportRow.id,
            page_index: pageIndexCounter++,
            source_type: p.source_type,
            filename: p.filename,
            displayed_page_number: p.displayed_page_number,
            text: p.text,
            extraction_status: p.extraction_status,
            rendered_page_path: newRenderedPath,
            width: p.width,
            height: p.height,
            image_regions: p.image_regions,
            page_pdf_path: null,
            visual_mime_type: p.visual_mime_type,
          })
          .select('id')
          .single();
        if (newPageError || !newPage) throw new Error(newPageError?.message ?? 'page_insert_failed');
        pageIdMap.set(p.id, newPage.id);
      }

      // stacks under this import: per-page (kind='page') and/or one shared merged 'custom' stack
      const stacksForImport = origStacks.filter((s) => (s.source_page_id ? pageIdMap.has(s.source_page_id) : s.id === origImport.merged_stack_id));
      const stackIdMap = new Map<string, string>();
      for (const s of stacksForImport) {
        const newSourcePageId = s.source_page_id ? (pageIdMap.get(s.source_page_id) ?? null) : null;
        const { data: newStack, error: newStackError } = await supabase
          .from('stacks')
          .insert({
            deck_id: clonedDeckId,
            name: s.name,
            kind: s.kind,
            source_page_id: newSourcePageId,
            version: 1,
            status: s.status,
            model: s.model,
            prompt_version: s.prompt_version,
            approved_with_warnings: s.approved_with_warnings,
            approval_override_reason: s.approval_override_reason,
            cloned_from_stack_id: s.id,
            added_by_sync_id: syncId,
          })
          .select('id')
          .single();
        if (newStackError || !newStack) throw new Error(newStackError?.message ?? 'stack_insert_failed');
        stackIdMap.set(s.id, newStack.id);
        stacksAdded++;
      }

      if (origImport.merged_stack_id && stackIdMap.has(origImport.merged_stack_id)) {
        const { error: relinkError } = await supabase.from('imports').update({ merged_stack_id: stackIdMap.get(origImport.merged_stack_id) }).eq('id', newImportRow.id);
        if (relinkError) throw new Error(relinkError.message);
      }

      for (const s of stacksForImport) {
        const newStackId = stackIdMap.get(s.id)!;
        const cardsForStack = (origCardsByStack.get(s.id) ?? []).slice().sort((a, b) => a.order_index - b.order_index);
        let orderIndex = 0;
        for (const c of cardsForStack) {
          // Each card's OWN source_page_id, never the stack's (null for a
          // custom/merged stack) — same cards_origin_source_page_consistency
          // requirement as case 1. pageIdMap already covers every page
          // under this import (all of pagesForImport was copied above,
          // not just ones tied to a 'page'-kind stack), so this is always
          // a plain lookup here, never a fresh copy.
          const cardSourcePageId = c.source_page_id ? (pageIdMap.get(c.source_page_id) ?? null) : null;
          await queueCard(c, newStackId, cardSourcePageId, orderIndex++, newImportRow.id);
        }
      }
    }

    await checkpoint(supabase, job.id, 'case3_done', { stacksAdded, pendingCardRows: pendingCardRows.length });

    await flushPendingCards();

    await checkpoint(supabase, job.id, 'cards_flushed', { stacksAdded, cardsAdded });

    await supabase.from('deck_syncs').update({ stacks_added: stacksAdded, cards_added: cardsAdded, imports_added: importsAdded }).eq('id', syncId);
    await supabase.rpc('complete_job', { p_job_id: job.id, p_result: { stacks_added: stacksAdded, cards_added: cardsAdded, imports_added: importsAdded } });
    return { claimed: true, jobId: job.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Only matches a row if the placeholder above was already written —
    // an error before that point (e.g. loading the decks) has nothing to
    // finalize, and that's fine: it still fails the job, just without a
    // history row for this one attempt.
    try {
      await supabase
        .from('deck_syncs')
        .update({ status: 'failed', error: message.slice(0, 2000), stacks_added: stacksAdded, cards_added: cardsAdded, imports_added: importsAdded })
        .eq('id', syncId);
    } catch {
      // best-effort
    }
    try {
      await supabase.rpc('fail_job', { p_job_id: job.id, p_error: `unhandled: ${message}`.slice(0, 2000) });
    } catch {
      // best-effort
    }
    return { claimed: true, jobId: job.id, error: message };
  }
}

/** Claims up to `batchSize` sync_deck jobs and processes them concurrently — each is fully independent (own pair of decks, own storage copies), same reasoning as processExtractionJobsBatch/processGenerateCardsJobsBatch. */
export async function processSyncDeckJobsBatch(supabase: SupabaseClient, batchSize: number): Promise<SyncDeckResult[]> {
  const { data: claimed, error: claimError } = await supabase.rpc('claim_jobs', { p_type: 'sync_deck', p_limit: batchSize });
  if (claimError) return [{ claimed: false, error: claimError.message }];
  if (!claimed || claimed.length === 0) return [];
  return Promise.all((claimed as SyncDeckJobRow[]).map((job) => processClaimedSyncJob(supabase, job)));
}
