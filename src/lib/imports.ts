import { supabase } from './supabase';
import { createJob } from './jobs';
import type { Import, ImportAudioFile, ImportFile, ImportFileStatus, ImportPage, ImportSourceType } from '../types';

const SOURCES_BUCKET = 'import-sources';
const AUDIO_BUCKET = 'import-audio';

/** The import flow's one required source: a PDF or image (paginated/single, shown alongside its cards), or a plain .txt file (real text, no page image). */
export const IMPORT_SOURCES: { type: ImportSourceType; label: string; required: boolean }[] = [
  { type: 'textbook', label: 'Source file', required: true },
];

/**
 * `customPrompt`, when set, is threaded into every page's extraction as
 * admin_instructions (see preprocessWorker.ts's ensureExtractionJobsExist)
 * — shapes the whole import's extraction, not per-page.
 *
 * `isImageSource` is deterministic, not a user choice (see SOURCE_PILLS /
 * classifyFileKind in pages/import.ts: an import may only contain one source
 * kind). When true — the source has no real page concept — this creates one
 * shared 'custom' stack up front (named after this import's title) and
 * records it as merged_stack_id, so every one of this import's generation
 * units files its cards there instead of each getting its own stack (see
 * extractWorker.ts). The per-unit stacks rows still get created either way
 * and still track each unit's own extraction attempt independently;
 * merged_stack_id only redirects where the resulting cards end up.
 */
export async function createImport(deckId: string, title: string, forceImageOnly?: boolean, customPrompt?: string, isImageSource?: boolean): Promise<Import> {
  let mergedStackId: string | undefined;
  if (isImageSource) {
    const { data: mergedStack, error: mergedStackError } = await supabase
      .from('stacks')
      .insert({ deck_id: deckId, name: title, kind: 'custom', version: 1 })
      .select('id')
      .single();
    if (mergedStackError) throw mergedStackError;
    mergedStackId = mergedStack.id;
  }

  const { data, error } = await supabase
    .from('imports')
    .insert({
      deck_id: deckId,
      title,
      ...(forceImageOnly ? { force_image_only: true } : {}),
      ...(customPrompt ? { custom_prompt: customPrompt } : {}),
      ...(mergedStackId ? { merged_stack_id: mergedStackId } : {}),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * A prompt-mode import with no attached source at all — cards are generated
 * purely from the admin's own knowledge, grounded by `prompt`, with nothing
 * to extract from (see the PROMPT-ONLY exception in pageExtraction.ts and
 * the isPromptOnly branch in extractWorker.ts). Reuses the same
 * imports/import_pages/stacks/jobs pipeline every other import goes
 * through — a real file just never enters the picture:
 *
 * - One shared 'custom' stack up front, same as an image-source import
 *   (there's no real "page" concept to give each generation unit its own
 *   stack).
 * - A synthetic `import_files` row (no real upload, no real storage object)
 *   exists purely because computeTextbookImportProgress (importProgress.ts)
 *   keys its very first branch off "is there a textbook file at all" —
 *   without one, the progress UI would show "Choose a source PDF to begin"
 *   forever regardless of the real extraction state.
 * - One synthetic `import_pages` row (text: null, no page image) that
 *   extractWorker.ts recognizes as prompt-only precisely because it has
 *   neither text nor a page image but admin_instructions is present.
 * - The extract_page job is queued directly (skipping preprocess_import
 *   entirely — there is nothing to preprocess).
 */
export async function createPromptOnlyImport(deckId: string, title: string, prompt: string): Promise<Import> {
  const { data: mergedStack, error: mergedStackError } = await supabase
    .from('stacks')
    .insert({ deck_id: deckId, name: title, kind: 'custom', version: 1 })
    .select('id')
    .single();
  if (mergedStackError) throw mergedStackError;

  const { data: inserted, error: importError } = await supabase
    .from('imports')
    .insert({ deck_id: deckId, title, custom_prompt: prompt, merged_stack_id: mergedStack.id })
    .select()
    .single();
  if (importError) throw importError;

  // status/total_pages/pages_discovered/pages_prepared are worker-owned
  // columns (see ImportInsert vs the Update type) — normally written by
  // preprocessWorker.ts as it goes, but there's no preprocessing step here
  // at all, so this jumps straight to "one page found and ready," matching
  // what preprocessWorker.ts would have left behind for a one-page import.
  const { data: imp, error: updateError } = await supabase
    .from('imports')
    .update({ status: 'extracting', total_pages: 1, pages_discovered: 1, pages_prepared: 1 })
    .eq('id', inserted.id)
    .select()
    .single();
  if (updateError) throw updateError;

  const { error: fileError } = await supabase.from('import_files').insert({
    import_id: imp.id,
    source_type: 'textbook',
    storage_path: '(none — prompt-only, no source file)',
    filename: '(prompt only — no source file)',
    status: 'completed',
    size_bytes: 0,
  });
  if (fileError) throw fileError;

  const { data: page, error: pageError } = await supabase
    .from('import_pages')
    .insert({
      import_id: imp.id,
      import_file_id: null,
      source_type: 'textbook',
      filename: '(prompt only)',
      page_index: 0,
      displayed_page_number: 1,
      text: null,
      extraction_status: 'extracted',
      error: null,
      image_regions: [],
      page_pdf_path: null,
      rendered_page_path: null,
      width: null,
      height: null,
      visual_mime_type: 'application/pdf',
    })
    .select('id')
    .single();
  if (pageError) throw pageError;

  await createJob({
    type: 'extract_page',
    deck_id: deckId,
    payload: { import_id: imp.id, page_id: page.id, admin_instructions: prompt },
  });

  return imp;
}

export function importFilePath(importId: string, sourceType: ImportSourceType, filename: string): string {
  return `${importId}/${sourceType}-${filename}`;
}

export async function createImportFileRecord(
  importId: string,
  sourceType: ImportSourceType,
  file: File,
): Promise<ImportFile> {
  const { data, error } = await supabase
    .from('import_files')
    .insert({
      import_id: importId,
      source_type: sourceType,
      storage_path: importFilePath(importId, sourceType, file.name),
      filename: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateImportFileStatus(
  id: string,
  status: ImportFileStatus,
  error_?: string | null,
): Promise<ImportFile> {
  const { data, error } = await supabase
    .from('import_files')
    .update({ status, error: error_ ?? null })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Uploads the file to the private import-sources bucket at its already-recorded storage_path. */
export async function uploadImportSourceFile(storagePath: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from(SOURCES_BUCKET).upload(storagePath, file, { upsert: true });
  if (error) throw error;
}

/**
 * Queues mechanical preprocessing (text + image-region extraction, no
 * provider call) for an import — a plain, fast `jobs` insert that returns
 * immediately. The actual work happens entirely server-side: the durable
 * dispatcher (pg_cron -> dispatch-import-work Edge Function) picks this job
 * up on its own schedule, so nothing here depends on the browser staying
 * open. Callers should only call this once, right after upload, while
 * `import.status` is still 'uploaded' — the worker moves it forward from
 * there, so re-checking status (not calling this blindly) is what keeps a
 * page reload from ever queueing a second preprocessing job.
 */
export async function enqueuePreprocessing(importId: string, deckId: string): Promise<void> {
  await createJob({ type: 'preprocess_import', deck_id: deckId, payload: { import_id: importId } });
}

/** Whether a preprocess_import job for this import is already queued/processing — used to gate "Resume"/"Retry" so a click never races a second job against a still-active one. */
export async function hasActivePreprocessJob(importId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'preprocess_import')
    .eq('payload->>import_id', importId)
    .in('status', ['queued', 'processing']);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Resumes preprocessing from wherever the persisted cursor
 * (`import.pages_discovered`) left off — the same enqueue as the initial
 * upload, since the worker itself decides whether that means "start from
 * page 0" or "continue from page N" (see preprocessWorker.ts). Never
 * duplicates a still-active job — callers should check
 * `hasActivePreprocessJob` first (this only guards at the DB level via
 * job-status filters, it does not itself re-check).
 */
export async function resumePreprocessing(importId: string, deckId: string): Promise<void> {
  await enqueuePreprocessing(importId, deckId);
}

/**
 * Permanently deletes an import and everything it produced — full cleanup,
 * not a soft hide. `imports` cascades (via FK ON DELETE CASCADE) through
 * `import_files` and `import_pages`, which in turn cascades to every
 * kind='page' stack and its cards (source_page_id) — that chain is already
 * enough for a pdf/doc import. An image-source import's shared merged
 * stack has no source_page_id, so it sits outside that chain entirely and
 * needs its own explicit delete first (which itself cascades to its
 * cards via stack_id). Irreversible — callers must confirm with the user
 * before calling this.
 */
export async function deleteImportCompletely(importId: string): Promise<void> {
  const { data: imp, error: fetchError } = await supabase.from('imports').select('merged_stack_id').eq('id', importId).single();
  if (fetchError) throw fetchError;
  if (imp.merged_stack_id) {
    const { error: stackError } = await supabase.from('stacks').delete().eq('id', imp.merged_stack_id);
    if (stackError) throw stackError;
  }
  const { error: importError } = await supabase.from('imports').delete().eq('id', importId);
  if (importError) throw importError;
}

/** The most recently-written failed page (for "Page 16 failed: <reason>" messaging) — null if none. */
export async function getLatestFailedPreprocessingPage(importId: string): Promise<{ displayedPageNumber: number; error: string } | null> {
  const { data, error } = await supabase
    .from('import_pages')
    .select('displayed_page_number, page_index, error')
    .eq('import_id', importId)
    .eq('extraction_status', 'unreadable')
    .order('page_index', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { displayedPageNumber: data.displayed_page_number ?? data.page_index + 1, error: data.error ?? 'unknown error' };
}

/** Re-queues only the pages currently marked unreadable — never re-parses pages that already succeeded. */
export async function retryFailedPreprocessingPages(importId: string, deckId: string): Promise<number> {
  const { data: failedPages, error } = await supabase
    .from('import_pages')
    .select('page_index')
    .eq('import_id', importId)
    .eq('extraction_status', 'unreadable');
  if (error) throw error;
  if (!failedPages.length) return 0;

  await createJob({
    type: 'preprocess_import',
    deck_id: deckId,
    payload: { import_id: importId, retry_page_indices: failedPages.map((p) => p.page_index) },
  });
  return failedPages.length;
}

export async function listImportPages(importId: string): Promise<ImportPage[]> {
  const { data, error } = await supabase
    .from('import_pages')
    .select('*')
    .eq('import_id', importId)
    .order('page_index', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getImportPage(pageId: string): Promise<ImportPage> {
  const { data, error } = await supabase.from('import_pages').select('*').eq('id', pageId).single();
  if (error) throw error;
  return data;
}

/** Fills in a page's rendered image, produced client-side (Edge Functions have no canvas). */
export async function updateImportPageRender(
  pageId: string,
  rendered: { rendered_page_path: string; width: number; height: number },
): Promise<void> {
  const { error } = await supabase.from('import_pages').update(rendered).eq('id', pageId);
  if (error) throw error;
}

export async function getImportById(importId: string): Promise<Import> {
  const { data, error } = await supabase.from('imports').select('*').eq('id', importId).single();
  if (error) throw error;
  return data;
}

/** Most recent import for a deck, or null if none exists yet — used to resume the import UI after a page reload. */
export async function getLatestImportForDeck(deckId: string): Promise<Import | null> {
  const { data, error } = await supabase
    .from('imports')
    .select('*')
    .eq('deck_id', deckId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listImportFiles(importId: string): Promise<ImportFile[]> {
  const { data, error } = await supabase.from('import_files').select('*').eq('import_id', importId).order('source_type');
  if (error) throw error;
  return data;
}

const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed'];

/** Every import for a deck — unfinished first, then most-recently-created — for the deck page's "Document imports" list. Never just "the latest" (an import is never lost once created). */
export async function listImportsForDeck(deckId: string): Promise<Import[]> {
  const { data, error } = await supabase.from('imports').select('*').eq('deck_id', deckId).order('created_at', { ascending: false });
  if (error) throw error;
  return [...data].sort((a, b) => {
    const aTerminal = TERMINAL_STATUSES.includes(a.status) ? 1 : 0;
    const bTerminal = TERMINAL_STATUSES.includes(b.status) ? 1 : 0;
    return aTerminal - bTerminal;
  });
}

// ---------- generic audio assets (section 7: no publisher-specific assumptions) ----------

/** Lowercased, extension-stripped, punctuation-stripped filename — the deterministic key audio_ref matching keys off of. */
export function normalizeAudioFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Pulls a leading/trailing track number out of a filename if present (e.g. "piste-12.mp3", "12 - dialogue.mp3"), else null. */
export function detectTrackNumber(filename: string): number | null {
  const m = filename.match(/(\d{1,3})/);
  return m ? parseInt(m[1], 10) : null;
}

export function importAudioFilePath(importId: string, filename: string): string {
  return `${importId}/${crypto.randomUUID()}-${filename}`;
}

export async function uploadImportAudioFile(importId: string, file: File): Promise<ImportAudioFile> {
  const storagePath = importAudioFilePath(importId, file.name);
  const { error: uploadError } = await supabase.storage.from(AUDIO_BUCKET).upload(storagePath, file);
  if (uploadError) throw uploadError;
  const { data, error } = await supabase
    .from('import_audio_files')
    .insert({
      import_id: importId,
      original_filename: file.name,
      normalized_filename: normalizeAudioFilename(file.name),
      storage_path: storagePath,
      track_number: detectTrackNumber(file.name),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listImportAudioFiles(importId: string): Promise<ImportAudioFile[]> {
  const { data, error } = await supabase
    .from('import_audio_files')
    .select('*')
    .eq('import_id', importId)
    .order('track_number', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data;
}

export async function deleteImportAudioFile(audioFile: ImportAudioFile): Promise<void> {
  const { error: storageError } = await supabase.storage.from(AUDIO_BUCKET).remove([audioFile.storage_path]);
  if (storageError) throw storageError;
  const { error } = await supabase.from('import_audio_files').delete().eq('id', audioFile.id);
  if (error) throw error;
}

/** Signed URL for a matched audio asset (bucket is private) — fetched on demand, never persisted. */
export async function getImportAudioUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(storagePath, 60 * 60);
  if (error || !data) throw error ?? new Error('could not create signed URL');
  return data.signedUrl;
}
