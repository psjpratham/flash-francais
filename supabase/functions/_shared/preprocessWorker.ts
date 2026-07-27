// Claims and processes a *bounded batch* of pages from a queued
// 'preprocess_import' job. This is pure library code — no HTTP handling, no
// auth handshake — called by the durable dispatcher (dispatch-import-work)
// with an already-built service-role Supabase client. The browser never
// invokes this directly.
//
// A full textbook can have far more pages than fit in one Edge Function
// invocation's execution-time limit. This never tries to process the whole
// PDF in one shot: each call processes pages for at most BATCH_TIME_BUDGET_MS
// wall-clock, persists progress after *every single page*, and if pages
// remain, re-queues the SAME job (status back to 'queued', never
// 'completed') so the next dispatcher tick resumes exactly where this one
// stopped — the resume cursor is `imports.pages_discovered` itself (pages
// 0..pages_discovered-1 are already written; nothing before that is ever
// re-parsed). One page's failure is caught individually and never aborts
// the batch — see the per-page try/catch below.
//
// Every Supabase call in the hot loop carries a hard timeout (DB_TIMEOUT_MS
// via AbortSignal, or a Promise.race wrapper for storage) so a single
// stalled network call fails fast and gets recorded as a page/job error
// instead of hanging until the platform kills the whole invocation with
// nothing ever recorded — that silent-death mode is exactly what produced
// the stuck-forever job this rewrite fixes.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { PDFDocument } from 'pdf-lib';

type ExtractionStatus = 'extracted' | 'image_only' | 'unreadable';
const BUCKET = 'import-sources';
const PAGE_PDF_BUCKET = 'import-page-pdfs';

// Comfortably below any plausible Edge Function wall-clock limit, leaving
// room for the dispatcher's own per-tick budget and the extraction half of
// the loop that runs in the same invocation (see dispatch-import-work).
const BATCH_TIME_BUDGET_MS = 20_000;
const DB_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
// A job orphaned in 'processing' this long genuinely died (platform kill,
// crash) rather than still legitimately working — the batch design above
// means a healthy job is never "processing" for anywhere near this long.
export const PREPROCESS_STALE_AFTER_MS = 5 * 60 * 1000;

interface ImportFileRow {
  id: string;
  storage_path: string;
  filename: string;
  mime_type: string | null;
}

interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  parserId?: string;
}

function isPdf(file: ImportFileRow): boolean {
  return file.mime_type === 'application/pdf' || file.filename.toLowerCase().endsWith('.pdf');
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------- best-effort image-region detection (unchanged logic) ----------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function unitSquareBBox(m: Matrix): { x: number; y: number; width: number; height: number } {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const MAX_REGIONS_PER_PAGE = 20;

async function detectImageRegions(page: unknown): Promise<ImageRegion[]> {
  try {
    const pdfjs = await getResolvedPDFJS();
    const OPS = (pdfjs as { OPS: Record<string, number> }).OPS;
    // deno-lint-ignore no-explicit-any
    const opList = await withTimeout((page as any).getOperatorList(), DB_TIMEOUT_MS, 'getOperatorList');
    const fnArray: number[] = opList.fnArray;
    const argsArray: unknown[][] = opList.argsArray;

    const regions: ImageRegion[] = [];
    const stack: Matrix[] = [];
    let ctm: Matrix = IDENTITY;

    for (let i = 0; i < fnArray.length && regions.length < MAX_REGIONS_PER_PAGE; i++) {
      const fn = fnArray[i];
      if (fn === OPS.save) {
        stack.push(ctm);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() ?? IDENTITY;
      } else if (fn === OPS.transform) {
        const args = argsArray[i] as number[];
        ctm = multiply(args as unknown as Matrix, ctm);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintInlineImageXObject) {
        const bbox = unitSquareBBox(ctm);
        const name = argsArray[i]?.[0];
        regions.push({ ...bbox, parserId: typeof name === 'string' ? name : undefined });
      }
    }
    return regions;
  } catch {
    // Best-effort only — a parser hiccup here must never fail the page's
    // text extraction, which is the part that actually matters.
    return [];
  }
}

// ---------- per-page text extraction (isolated per page, not a bulk call) ----------
//
// pdf.js's TextItem array arrives in PDF content-stream order — the order
// drawing operations happen to appear in the file, NOT visual reading
// order. For anything beyond a single column of body text (magazine-style
// two-column pages, floating photo captions, sidebars) this scrambles
// content badly: e.g. caption text physically positioned under a photo grid
// can appear in the stream nowhere near that photo, interleaved with an
// unrelated exercise instead. Every TextItem still carries its true (x, y)
// position on the page (from its transform matrix) even when the stream
// order doesn't reflect it, so the fix is a geometric reading-order sort:
// group into lines the way pdf.js already does (trusting hasEOL for
// intra-line word order, which is reliable), then re-sort those LINES by
// position — top-to-bottom (descending y, since PDF's origin is
// bottom-left), and left-to-right (ascending x) among lines close enough in
// y to be the same visual row (handles side-by-side columns). This is a
// heuristic, not a guarantee for every layout (e.g. rotated text, deeply
// irregular grids), but it is what actually fixes ordinary 2-column
// textbook pages and stray caption/photo-grid scrambling.

const SAME_ROW_Y_TOLERANCE = 3;

interface TextLine {
  text: string;
  x: number;
  y: number;
}

function buildLines(items: { str?: unknown; hasEOL?: unknown; transform?: unknown }[]): TextLine[] {
  const lines: TextLine[] = [];
  let buf = '';
  let x = 0;
  let y = 0;
  let started = false;
  for (const it of items) {
    if (!started && Array.isArray(it.transform)) {
      const t = it.transform as number[];
      x = t[4] ?? 0;
      y = t[5] ?? 0;
      started = true;
    }
    if (typeof it.str === 'string') buf += it.str;
    if (it.hasEOL) {
      if (buf.trim()) lines.push({ text: buf, x, y });
      buf = '';
      started = false;
    }
  }
  if (buf.trim()) lines.push({ text: buf, x, y });
  return lines;
}

/** Sorts lines into visual reading order from their true page position — see the module comment above for why this is necessary instead of trusting stream order. */
function sortIntoReadingOrder(lines: TextLine[]): TextLine[] {
  return [...lines].sort((a, b) => (Math.abs(a.y - b.y) > SAME_ROW_Y_TOLERANCE ? b.y - a.y : a.x - b.x));
}

async function extractOnePageText(pdf: unknown, pageIndex: number): Promise<{ text: string; imageRegions: ImageRegion[] }> {
  // deno-lint-ignore no-explicit-any
  const page = await withTimeout((pdf as any).getPage(pageIndex + 1), DB_TIMEOUT_MS, 'getPage');
  const textContent = await withTimeout(page.getTextContent(), DB_TIMEOUT_MS, 'getTextContent');
  const lines = sortIntoReadingOrder(buildLines(textContent.items));
  const text = lines.map((l) => l.text).join('\n');
  const imageRegions = text.trim() ? await detectImageRegions(page) : [];
  return { text, imageRegions };
}

// ---------- per-page single-page PDF slice (image-hybrid extraction input) ----------
// A byte-faithful copy of just this one page — vector graphics, exact
// fonts, no rasterization/cropping — the same idea as printing just this
// page to its own PDF. This is what extractWorker.ts attaches to the model
// call as visual/structural context alongside the (best-effort, heuristic)
// extracted text above; the text stays the source of truth for exact
// wording, the image is for layout the text extraction can't reliably capture.

function pagePdfStoragePath(importId: string, pageIndex: number): string {
  return `${importId}/${pageIndex}.pdf`;
}

async function sliceAndUploadPagePdf(
  supabase: SupabaseClient,
  pdfLibDoc: PDFDocument,
  importId: string,
  pageIndex: number,
): Promise<string | null> {
  try {
    const newDoc = await PDFDocument.create();
    const [copiedPage] = await newDoc.copyPages(pdfLibDoc, [pageIndex]);
    newDoc.addPage(copiedPage);
    const bytes = await newDoc.save();
    const path = pagePdfStoragePath(importId, pageIndex);
    const { error } = await withTimeout(
      supabase.storage.from(PAGE_PDF_BUCKET).upload(path, bytes, { upsert: true, contentType: 'application/pdf' }),
      DOWNLOAD_TIMEOUT_MS,
      'page pdf upload',
    );
    if (error) return null;
    return path;
  } catch {
    // Best-effort only, same as image-region detection — a slicing hiccup
    // on one page must never fail that page's (more important) text
    // extraction. extractWorker.ts falls back to a text-only model call
    // when page_pdf_path is null.
    return null;
  }
}

async function upsertImportPage(
  supabase: SupabaseClient,
  row: {
    import_id: string;
    import_file_id: string;
    filename: string;
    page_index: number;
    text: string | null;
    extraction_status: ExtractionStatus;
    error: string | null;
    image_regions: ImageRegion[];
    page_pdf_path: string | null;
  },
): Promise<void> {
  const query = supabase.from('import_pages').upsert(
    { ...row, source_type: 'textbook', displayed_page_number: row.page_index + 1 },
    { onConflict: 'import_id,page_index' },
  );
  const { error } = await withTimeout(query as unknown as PromiseLike<{ error: unknown }>, DB_TIMEOUT_MS, 'import_pages upsert');
  if (error) throw error instanceof Error ? error : new Error(String(error));
}

/** Recomputes pages_discovered/prepared/failed straight from import_pages — always exact, never drifts from incremental counters across retried/resumed batches. */
async function recomputeAndPersistCounts(supabase: SupabaseClient, importId: string, patch: Record<string, unknown> = {}): Promise<{ discovered: number; prepared: number; failed: number }> {
  const { data, error } = await withTimeout(
    supabase.from('import_pages').select('extraction_status').eq('import_id', importId) as unknown as PromiseLike<{ data: { extraction_status: ExtractionStatus }[] | null; error: unknown }>,
    DB_TIMEOUT_MS,
    'import_pages count',
  );
  if (error) throw error instanceof Error ? error : new Error(String(error));
  const rows = data ?? [];
  // 'image_only' pages have no text layer but a usable page image — they're
  // still extractable (see extractWorker.ts), so they count as prepared, not
  // failed. Only 'unreadable' (no text AND no image) is a genuine failure.
  const prepared = rows.filter((r) => r.extraction_status === 'extracted' || r.extraction_status === 'image_only').length;
  const failed = rows.length - prepared;
  const counts = { discovered: rows.length, prepared, failed };
  await touchImportProgress(supabase, importId, {
    pages_discovered: counts.discovered,
    pages_prepared: counts.prepared,
    pages_failed_preprocessing: counts.failed,
    ...patch,
  });
  return counts;
}

export interface PreprocessResult {
  claimed: boolean;
  jobId?: string;
  error?: string;
  /** False when the batch hit its time budget with pages still remaining — the job was re-queued, not completed/failed. */
  batchComplete?: boolean;
}

async function touchImportProgress(supabase: SupabaseClient, importId: string, patch: Record<string, unknown>): Promise<void> {
  const query = supabase
    .from('imports')
    .update({ ...patch, last_progress_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', importId);
  await withTimeout(query as unknown as PromiseLike<unknown>, DB_TIMEOUT_MS, 'imports update').catch(() => {
    // A progress heartbeat write that itself times out must never crash the
    // batch — the next successful write (or the stale-job fallback) catches up.
  });
}

/** Requeues preprocess_import jobs orphaned in 'processing' beyond PREPROCESS_STALE_AFTER_MS — the only recovery path for a batch invocation that died mid-flight instead of returning cleanly. Fallback only; the bounded-batch design above should make this rare. */
export async function requeueStalePreprocessJobs(supabase: SupabaseClient): Promise<number> {
  const thresholdISO = new Date(Date.now() - PREPROCESS_STALE_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .update({ status: 'queued', started_at: null })
    .eq('type', 'preprocess_import')
    .eq('status', 'processing')
    .or(`started_at.lt.${thresholdISO},and(started_at.is.null,created_at.lt.${thresholdISO})`)
    .select('id');
  if (error) return 0;
  return data?.length ?? 0;
}

/** Ensures every currently-'extracted' page has an extract_page job — per-page idempotent (never re-creates one that already exists), so a page fixed by a later retry still gets queued for extraction even if the import already moved past preprocessing once before. */
async function ensureExtractionJobsExist(supabase: SupabaseClient, importId: string, deckId: string, userId: string): Promise<void> {
  const { data: preparedPages, error: pagesError } = await supabase
    .from('import_pages')
    .select('id')
    .eq('import_id', importId)
    .in('extraction_status', ['extracted', 'image_only']);
  if (pagesError || !preparedPages?.length) return;

  const { data: existingJobs } = await supabase
    .from('jobs')
    .select('payload')
    .eq('type', 'extract_page')
    .eq('payload->>import_id', importId);
  const pageIdsWithJobs = new Set((existingJobs ?? []).map((j) => (j.payload as { page_id?: string })?.page_id).filter(Boolean));

  const missing = preparedPages.filter((p) => !pageIdsWithJobs.has(p.id));
  if (!missing.length) return;

  const rows = missing.map((p) => ({
    type: 'extract_page',
    user_id: userId,
    deck_id: deckId,
    payload: { import_id: importId, page_id: p.id },
  }));
  await supabase.from('jobs').insert(rows);
}

export async function processOnePreprocessJob(supabase: SupabaseClient): Promise<PreprocessResult> {
  const { data: claimed, error: claimError } = await supabase.rpc('claim_jobs', { p_type: 'preprocess_import', p_limit: 1 });
  if (claimError) return { claimed: false, error: claimError.message };
  if (!claimed || claimed.length === 0) return { claimed: false };

  const job = claimed[0] as { id: string; payload: { import_id: string; retry_page_indices?: number[] } };
  const importId = job.payload.import_id;
  const retryIndices = job.payload.retry_page_indices;

  const { data: importRow, error: importError } = await supabase
    .from('imports')
    .select('id, deck_id, user_id, total_pages, pages_discovered, force_image_only')
    .eq('id', importId)
    .single();
  if (importError || !importRow) {
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'import not found' });
    return { claimed: true, jobId: job.id, error: 'import_not_found' };
  }

  if (!retryIndices?.length) await touchImportProgress(supabase, importId, { status: 'preprocessing' });

  try {
    const { data: files, error: filesError } = await supabase
      .from('import_files')
      .select('id, storage_path, filename, mime_type')
      .eq('import_id', importId)
      .eq('source_type', 'textbook');
    if (filesError) throw new Error('could not load import_files');

    const textbookFile = (files ?? [])[0] as ImportFileRow | undefined;
    if (!textbookFile) throw new Error('textbook_required');
    if (!isPdf(textbookFile)) throw new Error('textbook_must_be_pdf');

    const { data: blob, error: downloadError } = await withTimeout(
      supabase.storage.from(BUCKET).download(textbookFile.storage_path),
      DOWNLOAD_TIMEOUT_MS,
      'textbook download',
    );
    if (downloadError || !blob) throw new Error(`could not download textbook file: ${downloadError?.message ?? 'unknown'}`);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pdf = await withTimeout(getDocumentProxy(bytes), DB_TIMEOUT_MS, 'open PDF');
    // Loaded once per batch (not per page) and reused for every page's
    // slice below — best-effort: a source PDF pdf.js tolerates but pdf-lib
    // can't parse just means no page slices this batch, never a failure.
    const pdfLibDoc = await PDFDocument.load(bytes, { ignoreEncryption: true }).catch(() => null);

    const totalPages = pdf.numPages;
    if (importRow.total_pages !== totalPages) {
      await touchImportProgress(supabase, importId, { total_pages: totalPages });
    }

    // Retry mode reprocesses only the specific pages named in the job
    // payload (used by "Retry failed pages"); normal mode resumes
    // sequentially from the persisted cursor (pages_discovered) so already-
    // written pages are never re-parsed.
    const targetIndices = retryIndices?.length ? retryIndices : Array.from({ length: totalPages - (importRow.pages_discovered ?? 0) }, (_, i) => (importRow.pages_discovered ?? 0) + i);

    const batchStart = Date.now();
    let processedInBatch = 0;
    for (const i of targetIndices) {
      if (Date.now() - batchStart > BATCH_TIME_BUDGET_MS) break; // bounded — remaining pages picked up by the next invocation

      await touchImportProgress(supabase, importId, { current_page_index: i });

      try {
        const { text, imageRegions } = await extractOnePageText(pdf, i);
        // force_image_only is an admin test toggle (see the imports column
        // comment) that deliberately ignores any embedded text layer found —
        // it routes every page through the same image-only path a scanned
        // page would take, to A/B-test extraction quality between the two.
        const hasText = !importRow.force_image_only && !!text.trim();
        // A page-PDF slice is attempted regardless of whether the text layer
        // came back empty — it's the only way a scanned/image-only page (no
        // embedded text objects at all) can still reach extraction, via the
        // model reading the page image directly instead of numbered lines.
        const pagePdfPath = pdfLibDoc ? await sliceAndUploadPagePdf(supabase, pdfLibDoc, importId, i) : null;
        const status: ExtractionStatus = hasText ? 'extracted' : pagePdfPath ? 'image_only' : 'unreadable';
        await upsertImportPage(supabase, {
          import_id: importId,
          import_file_id: textbookFile.id,
          filename: textbookFile.filename,
          page_index: i,
          text: hasText ? text : null,
          extraction_status: status,
          error: status === 'unreadable' ? 'no embedded text layer and no page image could be produced' : null,
          image_regions: imageRegions,
          page_pdf_path: pagePdfPath,
        });
      } catch (pageError) {
        // One page's failure is recorded on that page alone and never
        // aborts the batch — page i+1 is attempted next regardless.
        const message = pageError instanceof Error ? pageError.message : String(pageError);
        await upsertImportPage(supabase, {
          import_id: importId,
          import_file_id: textbookFile.id,
          filename: textbookFile.filename,
          page_index: i,
          text: null,
          extraction_status: 'unreadable',
          error: message,
          image_regions: [],
          page_pdf_path: null,
        }).catch(() => {
          /* if even recording the failure fails, the page just stays absent — next batch/retry will attempt it again */
        });
      }

      processedInBatch++;
      await recomputeAndPersistCounts(supabase, importId);
    }

    const isRetryBatch = !!retryIndices?.length;
    const remainingTarget = targetIndices.slice(processedInBatch);

    if (remainingTarget.length > 0) {
      // Time budget hit with work left — requeue the SAME job (never
      // complete/fail it) so the next dispatcher tick picks up exactly
      // where this one stopped.
      await touchImportProgress(supabase, importId, { current_page_index: null });
      await supabase
        .from('jobs')
        .update({
          status: 'queued',
          started_at: null,
          payload: isRetryBatch ? { import_id: importId, retry_page_indices: remainingTarget } : { import_id: importId },
        })
        .eq('id', job.id);
      return { claimed: true, jobId: job.id, batchComplete: false };
    }

    const counts = await recomputeAndPersistCounts(supabase, importId);
    const sequentialComplete = counts.discovered >= totalPages;

    if (sequentialComplete) {
      if (counts.prepared === 0) {
        await touchImportProgress(supabase, importId, { status: 'failed', preprocessing_error: 'No page could be processed — the file may be corrupted, password-protected, or not a valid PDF.' });
      } else {
        await ensureExtractionJobsExist(supabase, importId, importRow.deck_id, importRow.user_id);
        // Never regress a later-stage status (extracting/needs_review/
        // completed/completed_with_errors) — this branch only advances a
        // page that just got fixed by a targeted retry after everything
        // else already moved on.
        const { data: current } = await supabase.from('imports').select('status').eq('id', importId).single();
        if (!current || current.status === 'preprocessing' || current.status === 'uploaded' || current.status === 'failed') {
          await touchImportProgress(supabase, importId, { status: 'extracting', current_page_index: null, preprocessing_error: null });
        }
      }
    } else if (isRetryBatch) {
      // Retry batch finished its specific pages, but sequential discovery
      // was never the concern here — leave overall status untouched.
      await touchImportProgress(supabase, importId, { current_page_index: null });
    }

    await supabase.rpc('complete_job', {
      p_job_id: job.id,
      p_result: { total_pages: totalPages, pages_prepared: counts.prepared, pages_failed: counts.failed, pages_discovered: counts.discovered },
    });

    return { claimed: true, jobId: job.id, batchComplete: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await touchImportProgress(supabase, importId, { status: 'failed', preprocessing_error: message });
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: message });
    return { claimed: true, jobId: job.id, error: message };
  }
}
