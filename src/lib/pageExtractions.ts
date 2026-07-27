import { supabase } from './supabase';
import type { ImportPage, NoteFields, PageBlock, PageBlockUpdate, PageExtraction } from '../types';

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

export async function getExtractionProgress(importId: string): Promise<ExtractionProgress> {
  const rows = await fetchJobRows(importId);
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

/** Queues a fresh re-extraction of one page (a new page_extractions version), optionally with admin guidance for the repair/extraction prompt. Never touches other pages. */
export async function requeuePageExtraction(importId: string, deckId: string, pageId: string, adminInstructions?: string): Promise<void> {
  const { error } = await supabase.from('jobs').insert({
    type: JOB_TYPE,
    deck_id: deckId,
    payload: { import_id: importId, page_id: pageId, admin_instructions: adminInstructions ?? null },
  });
  if (error) throw error;
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
export async function getCurrentPageExtraction(pageId: string): Promise<PageExtraction | null> {
  const { data, error } = await supabase
    .from('page_extractions')
    .select('*')
    .eq('page_id', pageId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listPageBlocks(pageExtractionId: string): Promise<PageBlock[]> {
  const { data, error } = await supabase
    .from('page_blocks')
    .select('*')
    .eq('page_extraction_id', pageExtractionId)
    .order('order_index', { ascending: true });
  if (error) throw error;
  return data;
}

export async function updatePageBlock(blockId: string, patch: PageBlockUpdate): Promise<PageBlock> {
  const { data, error } = await supabase.from('page_blocks').update(patch).eq('id', blockId).select().single();
  if (error) throw error;
  return data;
}

export async function deletePageBlock(blockId: string): Promise<void> {
  const { error } = await supabase.from('page_blocks').delete().eq('id', blockId);
  if (error) throw error;
}

/** Inserts a new manually-added block at the given order_index — callers are responsible for shifting other blocks' order_index first if inserting mid-page. */
export async function insertPageBlock(block: {
  page_extraction_id: string;
  page_id: string;
  order_index: number;
  kind: PageBlock['kind'];
  component_type: string;
  content: PageBlock['content'];
}): Promise<PageBlock> {
  const { data, error } = await supabase
    .from('page_blocks')
    .insert({ ...block, source_line_ids: [], source_text: '', needs_review: true, review_reason: 'manually added during review' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function reorderPageBlocks(updates: { id: string; order_index: number }[]): Promise<void> {
  for (const u of updates) {
    const { error } = await supabase.from('page_blocks').update({ order_index: u.order_index }).eq('id', u.id);
    if (error) throw error;
  }
}

// ---------- sending reviewed blocks to practice ----------

/** Plain-text fallback shown wherever a note's fields are read directly (search, the old flashcard UI) — the actual session rendering for these notes uses the live source_block_id join instead, not these fields. */
function blockToNoteFields(b: PageBlock): NoteFields {
  const front = b.title || b.instruction || b.source_text.slice(0, 160) || '(imported card)';
  return { front, back: b.translation ?? '' };
}

/** How many of a page's current blocks already have a practice note (for the review UI's "N/M sent" state). */
export async function countBlocksSentToPractice(pageBlockIds: string[]): Promise<number> {
  if (!pageBlockIds.length) return 0;
  const { count, error } = await supabase
    .from('notes')
    .select('id', { count: 'exact', head: true })
    .in('source_block_id', pageBlockIds);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Compiles a page's current blocks (in their current, admin-reordered
 * order_index) into practice notes+cards, one each, skipping any block
 * that's already been sent — safe to click again after adding/reordering
 * blocks on an already-sent page. Reuses the exact same FSRS 'new' card
 * shape bulkInsertNotesAndCards uses for manually-authored cards.
 */
export async function sendPageBlocksToPractice(pageId: string, deckId: string): Promise<{ sent: number; alreadySent: number }> {
  const { data: blocks, error: blocksError } = await supabase.from('page_blocks').select('*').eq('page_id', pageId).order('order_index', { ascending: true });
  if (blocksError) throw blocksError;
  if (!blocks?.length) return { sent: 0, alreadySent: 0 };

  const { data: existingNotes, error: existingError } = await supabase
    .from('notes')
    .select('source_block_id')
    .in(
      'source_block_id',
      blocks.map((b) => b.id),
    );
  if (existingError) throw existingError;
  const alreadySentIds = new Set((existingNotes ?? []).map((n) => n.source_block_id));
  const toSend = blocks.filter((b) => !alreadySentIds.has(b.id));
  if (!toSend.length) return { sent: 0, alreadySent: blocks.length };

  const { data: noteRows, error: notesError } = await supabase
    .from('notes')
    .insert(
      toSend.map((b) => ({
        deck_id: deckId,
        note_type: 'basic' as const,
        tags: b.tags,
        fields: blockToNoteFields(b),
        source_block_id: b.id,
      })),
    )
    .select();
  if (notesError) throw notesError;

  const cardRows = noteRows.map((n) => ({ note_id: n.id, deck_id: deckId, state: 'new' as const, due: new Date().toISOString() }));
  const { error: cardsError } = await supabase.from('cards').insert(cardRows);
  if (cardsError) throw cardsError;

  return { sent: toSend.length, alreadySent: blocks.length - toSend.length };
}

/** Approves a page's current extraction — blocked server-side (see approve_page_extraction RPC) while unresolved_warnings is non-empty. */
/** Approves a page's current extraction. If it has unresolved warnings, `force` + a non-empty `overrideReason` are required — the server rejects it otherwise, so the override is always deliberate and always recorded. */
export async function approvePageExtraction(pageExtractionId: string, force = false, overrideReason?: string): Promise<PageExtraction> {
  const { data, error } = await supabase.rpc('approve_page_extraction', {
    p_page_extraction_id: pageExtractionId,
    p_force: force,
    p_override_reason: overrideReason ?? null,
  });
  if (error) throw error;
  return data;
}

/** Whether this import has any page extraction yet — used to surface "Review pages" as soon as one page finishes. */
export async function hasAnyPageExtractions(importId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('page_extractions')
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
    .from('page_extractions')
    .select('page_id, version, status, import_pages!inner(import_id)')
    .eq('import_pages.import_id', importId);
  if (error) throw error;

  const latestByPage = new Map<string, { version: number; status: string }>();
  for (const row of data as unknown as { page_id: string; version: number; status: string }[]) {
    const current = latestByPage.get(row.page_id);
    if (!current || row.version > current.version) latestByPage.set(row.page_id, { version: row.version, status: row.status });
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
