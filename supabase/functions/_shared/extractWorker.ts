// Claims and processes exactly one queued 'extract_page' job. Pure library
// code (no HTTP handling) — called by the durable dispatcher
// (dispatch-import-work) with an already-built service-role Supabase
// client. The completeness pipeline (deterministic coverage -> conditional
// audit -> bounded repair) is unchanged from last session.
//
// After completing or failing a job, checks whether any extract_page jobs
// remain queued/processing for that import; if none, this was the last one
// out, so it finalizes imports.status to needs_review / completed_with_errors
// / failed based on the final per-page review counts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { encodeBase64 } from '@std/encoding/base64';
import { callGemini, getConfiguredGeminiModel, parseJsonContent, type ProviderUsage } from './gemini.ts';
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  COMPLETENESS_AUDIT_SYSTEM_PROMPT,
  REPAIR_SYSTEM_PROMPT,
  POLISH_SYSTEM_PROMPT,
  buildUserPrompt,
  buildAuditUserPrompt,
  buildRepairUserPrompt,
  buildPolishUserPrompt,
  type ImageRegionInput,
} from './prompts/pageExtraction.ts';
import { formatNumberedLines, toSourceLines, type SourceLine } from './sourceLines.ts';
import { validatePage, type ValidatedBlock } from './blockValidation.ts';
import { checkCoverage, coverageHasIssues, type CoverageResult } from './coverage.ts';

const MAX_CHARS_PER_REQUEST = 6000;
const MAX_REPAIR_ATTEMPTS = 2;
const JOB_TIME_BUDGET_MS = 150_000;
const PAGE_PDF_BUCKET = 'import-page-pdfs';
const SOURCES_BUCKET = 'import-sources';
const PAGE_PDF_DOWNLOAD_TIMEOUT_MS = 15_000;

/** Downloads and base64-encodes this page's single-page PDF slice — null (never a thrown error) when there isn't one, so extraction always falls back to text-only rather than failing the job over a missing/broken attachment. */
async function loadPagePdfBase64(supabase: SupabaseClient, pagePdfPath: string | null): Promise<string | null> {
  if (!pagePdfPath) return null;
  try {
    const download = supabase.storage.from(PAGE_PDF_BUCKET).download(pagePdfPath);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('page pdf download timed out')), PAGE_PDF_DOWNLOAD_TIMEOUT_MS));
    const { data: blob, error } = await Promise.race([download, timeout]);
    if (error || !blob) return null;
    return encodeBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}

/** Downloads and base64-encodes the import's optional answer key (corrigé), shared by every page in the import — null (never a thrown error) when there isn't one or the download fails, so a missing/broken answer key just means no card gets an answer this run, never a failed job. */
async function loadAnswerKeyBase64(supabase: SupabaseClient, storagePath: string | null): Promise<string | null> {
  if (!storagePath) return null;
  try {
    const download = supabase.storage.from(SOURCES_BUCKET).download(storagePath);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('answer key download timed out')), PAGE_PDF_DOWNLOAD_TIMEOUT_MS));
    const { data: blob, error } = await Promise.race([download, timeout]);
    if (error || !blob) return null;
    return encodeBase64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}

interface PageWarningOut {
  code: string;
  message: string;
  source_line_ids?: string[];
}

function splitIntoLineChunks(lines: SourceLine[]): SourceLine[][] {
  const chunks: SourceLine[][] = [];
  let current: SourceLine[] = [];
  let currentChars = 0;
  for (const line of lines) {
    const lineChars = line.text.length + 8;
    if (current.length > 0 && currentChars + lineChars > MAX_CHARS_PER_REQUEST) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += lineChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface ExtractionCallResult {
  ok: boolean;
  blocks?: ValidatedBlock[];
  pageWarnings?: PageWarningOut[];
  detectedLanguage?: string | null;
  raw?: unknown;
  usage?: ProviderUsage;
  latencyMs?: number;
  model?: string;
  error?: string;
}

const MAX_JSON_PARSE_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS_CEILING = 65536;

async function runOneExtractionCall(
  numberedLines: string,
  imageRegions: ImageRegionInput[],
  pagePdfBase64: string | null,
  adminInstructions?: string | null,
  imageOnly?: boolean,
  existingTags?: string[],
  visualMimeType = 'application/pdf',
  answerKey?: { mimeType: string; base64: string } | null,
  promptOnly?: boolean,
): Promise<ExtractionCallResult> {
  const inlineData = [pagePdfBase64 ? { mimeType: visualMimeType, base64: pagePdfBase64 } : null, answerKey ? { mimeType: answerKey.mimeType, base64: answerKey.base64 } : null].filter(
    (d): d is { mimeType: string; base64: string } => d !== null,
  );
  const baseCallParams = {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt({ pageNumber: 0, numberedSourceLines: numberedLines, imageRegions, adminInstructions, imageOnly, promptOnly, existingTags, hasAnswerKey: !!answerKey }),
    inlineData: inlineData.length ? inlineData : undefined,
  };

  let latencyMs = 0;
  let usage: ProviderUsage | undefined;
  let model = '';
  let parsed: ReturnType<typeof parseJsonContent> | undefined;
  let maxOutputTokens: number | undefined;

  // A malformed-JSON response can mean two different things, handled two
  // different ways: an occasional transient formatting glitch (retry as-is
  // usually succeeds), or a genuinely truncated response
  // (finishReason:'MAX_TOKENS' — verified directly against this API: a
  // dense page needing ~22 blocks ran past the default token budget and cut
  // off mid-JSON-string, deterministically, every time, until given a
  // larger budget). Doubling the budget on a MAX_TOKENS retry (instead of
  // blindly repeating the same call) is what actually fixes the second
  // case; neither retry path masks a genuine structural problem, since
  // validatePage still runs on whatever comes back.
  for (let attempt = 0; attempt < MAX_JSON_PARSE_ATTEMPTS; attempt++) {
    const outcome = await callGemini({ ...baseCallParams, maxOutputTokens });
    latencyMs += outcome.latencyMs;
    model = outcome.model;
    if (!outcome.ok) return { ok: false, error: outcome.error, latencyMs, model };
    usage = outcome.usage;
    parsed = parseJsonContent(outcome.content);
    if (parsed.ok) break;
    if (outcome.finishReason === 'MAX_TOKENS') {
      const current = maxOutputTokens ?? usage?.completionTokens ?? 24576;
      maxOutputTokens = Math.min(current * 2, MAX_OUTPUT_TOKENS_CEILING);
    }
  }
  if (!parsed || !parsed.ok) return { ok: false, error: parsed?.error ?? 'no provider response', usage, latencyMs, model };

  const validated = validatePage(parsed.value);
  if (!validated.ok || !validated.value) {
    return { ok: false, error: validated.error, usage, latencyMs, model, raw: parsed.value };
  }
  return {
    ok: true,
    blocks: validated.value.blocks,
    pageWarnings: validated.value.page_warnings,
    detectedLanguage: validated.value.detected_language,
    raw: parsed.value,
    usage,
    latencyMs,
    model,
  };
}

async function runFullExtraction(
  sourceLines: SourceLine[],
  imageRegions: ImageRegionInput[],
  pagePdfBase64: string | null,
  adminInstructions?: string | null,
  imageOnly?: boolean,
  existingTags?: string[],
  visualMimeType = 'application/pdf',
  answerKey?: { mimeType: string; base64: string } | null,
  promptOnly?: boolean,
): Promise<{
  ok: boolean;
  blocks: ValidatedBlock[];
  pageWarnings: PageWarningOut[];
  detectedLanguage: string | null;
  raw: unknown[];
  totalLatencyMs: number;
  usage: ProviderUsage;
  model: string;
  error?: string;
}> {
  // An image-only or prompt-only page has zero source lines, so
  // splitIntoLineChunks would otherwise produce zero chunks and skip
  // extraction entirely — force one (empty) chunk so the model still gets
  // called (with the page image, or with nothing but admin_instructions).
  const chunks = sourceLines.length ? splitIntoLineChunks(sourceLines) : imageOnly || promptOnly ? [[]] : [];
  let orderCursor = 0;
  const allBlocks: ValidatedBlock[] = [];
  const allWarnings: PageWarningOut[] = [];
  const allRaw: unknown[] = [];
  let totalLatencyMs = 0;
  const usage: ProviderUsage = {};
  let model = getConfiguredGeminiModel();
  let detectedLanguage: string | null = null;

  for (const chunk of chunks) {
    // The page-PDF attachment (like imageRegions) is only sent once per
    // page — on the single/first chunk — rather than re-uploaded with every
    // chunked call for an unusually text-dense page.
    const isFirstChunk = chunks.length === 1 || chunks.indexOf(chunk) === 0;
    const result = await runOneExtractionCall(
      formatNumberedLines(chunk),
      isFirstChunk ? imageRegions : [],
      isFirstChunk ? pagePdfBase64 : null,
      adminInstructions,
      imageOnly,
      existingTags,
      visualMimeType,
      isFirstChunk ? answerKey : null,
      promptOnly,
    );
    totalLatencyMs += result.latencyMs ?? 0;
    if (result.model) model = result.model;
    if (!detectedLanguage && result.detectedLanguage) detectedLanguage = result.detectedLanguage;
    if (result.usage) {
      usage.promptTokens = (usage.promptTokens ?? 0) + (result.usage.promptTokens ?? 0);
      usage.completionTokens = (usage.completionTokens ?? 0) + (result.usage.completionTokens ?? 0);
      usage.totalTokens = (usage.totalTokens ?? 0) + (result.usage.totalTokens ?? 0);
    }
    if (result.raw) allRaw.push(result.raw);
    if (!result.ok || !result.blocks) {
      return { ok: false, blocks: allBlocks, pageWarnings: allWarnings, detectedLanguage, raw: allRaw, totalLatencyMs, usage, model, error: result.error };
    }
    for (const b of result.blocks) allBlocks.push({ ...b, order_index: orderCursor++ });
    allWarnings.push(...(result.pageWarnings ?? []));
  }

  return { ok: true, blocks: allBlocks, pageWarnings: allWarnings, detectedLanguage, raw: allRaw, totalLatencyMs, usage, model };
}

function coverageToWarnings(coverage: CoverageResult): PageWarningOut[] {
  const warnings: PageWarningOut[] = [];
  if (coverage.missingLineIds.length) {
    warnings.push({ code: 'missing_lines', message: 'Source lines not represented by any block', source_line_ids: coverage.missingLineIds });
  }
  if (coverage.duplicatedLineIds.length) {
    warnings.push({ code: 'duplicated_lines', message: 'Source lines referenced by more than one block', source_line_ids: coverage.duplicatedLineIds });
  }
  for (const a of coverage.alteredText) {
    warnings.push({ code: 'altered_text', message: a.issue, source_line_ids: a.lineIds });
  }
  for (const o of coverage.orderingIssues) {
    warnings.push({ code: 'ordering_issue', message: o });
  }
  if (coverage.invalidLineReferences.length) {
    warnings.push({ code: 'invalid_line_reference', message: 'Block referenced a source line id that does not exist', source_line_ids: coverage.invalidLineReferences });
  }
  if (coverage.missingTranslationOrderIndexes.length) {
    warnings.push({ code: 'missing_translation', message: `Blocks at order_index [${coverage.missingTranslationOrderIndexes.join(', ')}] have content but no translation` });
  }
  return warnings;
}

function auditToWarnings(audit: Record<string, unknown>): PageWarningOut[] {
  const warnings: PageWarningOut[] = [];
  const arr = (k: string): unknown[] => (Array.isArray(audit[k]) ? (audit[k] as unknown[]) : []);
  if (arr('missing_line_ids').length) warnings.push({ code: 'audit_missing_lines', message: 'Audit found missing source lines', source_line_ids: arr('missing_line_ids') as string[] });
  if (arr('duplicated_line_ids').length) warnings.push({ code: 'audit_duplicated_lines', message: 'Audit found duplicated source lines', source_line_ids: arr('duplicated_line_ids') as string[] });
  for (const issue of arr('altered_text')) {
    const a = issue as { line_ids?: string[]; issue?: string };
    warnings.push({ code: 'audit_altered_text', message: a.issue ?? 'altered text', source_line_ids: a.line_ids });
  }
  for (const issue of arr('ordering_issues')) warnings.push({ code: 'audit_ordering_issue', message: String(issue) });
  for (const issue of arr('incorrect_component_mappings')) warnings.push({ code: 'audit_incorrect_mapping', message: String(issue) });
  for (const issue of arr('invented_content')) warnings.push({ code: 'audit_invented_content', message: String(issue) });
  for (const issue of arr('missing_image_refs')) warnings.push({ code: 'audit_missing_image_ref', message: String(issue) });
  for (const issue of arr('missing_audio_refs')) warnings.push({ code: 'audit_missing_audio_ref', message: String(issue) });
  for (const issue of arr('choice_intent_errors')) warnings.push({ code: 'audit_choice_intent_error', message: String(issue) });
  for (const issue of arr('formatting_fidelity_issues')) warnings.push({ code: 'audit_formatting_fidelity_issue', message: String(issue) });
  for (const issue of arr('composed_activity_misuse')) warnings.push({ code: 'audit_composed_activity_misuse', message: String(issue) });
  for (const issue of arr('missing_section_metadata')) warnings.push({ code: 'audit_missing_section_metadata', message: String(issue) });
  for (const issue of arr('reading_order_issues')) warnings.push({ code: 'audit_reading_order_issue', message: String(issue) });
  for (const issue of arr('merged_subquestion_issues')) warnings.push({ code: 'audit_merged_subquestion_issue', message: String(issue) });
  for (const issue of arr('translation_issues')) warnings.push({ code: 'audit_translation_issue', message: String(issue) });
  return warnings;
}

/** Sets imports.status once no extract_page jobs remain queued/processing for it — the last job out finalizes the import. Never touches a still-active import. */
async function maybeFinalizeImport(supabase: SupabaseClient, importId: string): Promise<void> {
  const { data: activeJobs } = await supabase
    .from('jobs')
    .select('id')
    .eq('type', 'extract_page')
    .eq('payload->>import_id', importId)
    .in('status', ['queued', 'processing'])
    .limit(1);
  if (activeJobs && activeJobs.length > 0) return; // still work left — not this call's job to finalize

  // A retried page's extraction is a brand-new job row, never an update of
  // the old one — the old terminal row is kept as attempt history. Only the
  // most recent job per page reflects that page's current outcome; without
  // this dedup, an old 'failed' row from before a successful retry would
  // pin the import at completed_with_errors forever.
  const { data: allJobs } = await supabase
    .from('jobs')
    .select('status, payload, created_at')
    .eq('type', 'extract_page')
    .eq('payload->>import_id', importId);

  const latestByPage = new Map<string, { status: string; created_at: string }>();
  for (const row of (allJobs ?? []) as { status: string; payload: { page_id: string }; created_at: string }[]) {
    const pageId = row.payload.page_id;
    const current = latestByPage.get(pageId);
    if (!current || new Date(row.created_at).getTime() > new Date(current.created_at).getTime()) {
      latestByPage.set(pageId, { status: row.status, created_at: row.created_at });
    }
  }

  const anyFailed = [...latestByPage.values()].some((j) => j.status === 'failed');
  const anyCompleted = [...latestByPage.values()].some((j) => j.status === 'completed');

  const status = !anyCompleted ? 'failed' : anyFailed ? 'completed_with_errors' : 'needs_review';
  await supabase
    .from('imports')
    .update({ status, updated_at: new Date().toISOString(), last_progress_at: new Date().toISOString() })
    .eq('id', importId)
    // Never downgrade an import that a reviewer has already fully approved
    // (status='completed') back to needs_review/completed_with_errors —
    // that only happens via a deliberate re-extraction, which itself resets
    // status to 'extracting' before this function ever runs again.
    .neq('status', 'completed');
}

export interface ExtractResult {
  claimed: boolean;
  jobId?: string;
  error?: string;
}

type ExtractJobRow = {
  id: string;
  payload: { import_id: string; page_id: string; admin_instructions?: string | null; answer_key_storage_path?: string | null; answer_key_mime_type?: string | null };
};

/** Processes one already-claimed extract_page job end to end (extraction, audit/repair, block insert, finalize). Pulled out of processOneExtractionJob so a batch of claimed jobs can each be handed to this and run concurrently — see processExtractionJobsBatch. */
async function processClaimedExtractionJob(supabase: SupabaseClient, job: ExtractJobRow): Promise<ExtractResult> {
  const { import_id: importId, page_id: pageId, admin_instructions: adminInstructions, answer_key_storage_path: answerKeyStoragePath, answer_key_mime_type: answerKeyMimeType } = job.payload;

  const { data: page, error: pageError } = await supabase
    .from('import_pages')
    .select('id, text, extraction_status, image_regions, page_pdf_path, visual_mime_type, displayed_page_number, page_index')
    .eq('id', pageId)
    .single();
  if (pageError || !page) {
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not load page' });
    await maybeFinalizeImport(supabase, importId);
    return { claimed: true, jobId: job.id, error: 'page_missing' };
  }
  const isTextExtracted = page.extraction_status === 'extracted' && !!page.text;
  // 'image_only' pages have no text layer but a usable page-PDF slice — the
  // model reads wording directly off the image instead of numbered lines
  // (see the imageOnly branch below and pageExtraction.ts's IMAGE-ONLY
  // PAGES exception).
  const isImageOnly = page.extraction_status === 'image_only' && !!page.page_pdf_path;
  // No text AND no page image AND admin_instructions present — a prompt-
  // only import (see createPromptOnlyImport in src/lib/imports.ts): there
  // is no source at all, only a request describing what to generate. Never
  // true when adminInstructions is absent — that combination has genuinely
  // nothing to work from and must still fail below, same as always.
  const isPromptOnly = !page.text && !page.page_pdf_path && !!adminInstructions;
  if (!isTextExtracted && !isImageOnly && !isPromptOnly) {
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'page has no extracted text or page image to work from' });
    await maybeFinalizeImport(supabase, importId);
    return { claimed: true, jobId: job.id, error: 'page_has_no_text' };
  }

  // stacks (formerly page_extractions) needs deck_id/name up front now —
  // both previously reachable only lazily via RLS joins, now required
  // NOT NULL columns on insert. merged_stack_id, when set, is where this
  // page's CARDS actually get filed (see the cards.insert below) — the
  // per-page stacks row below is still always created and still always
  // tracks this one page's own extraction attempt/status/warnings/version,
  // completely unaffected by merge. That's what makes unmerge trivial later:
  // the original per-page stack never goes away, merge only redirects where
  // the resulting cards live.
  const { data: importRow, error: importRowError } = await supabase.from('imports').select('deck_id, merged_stack_id').eq('id', importId).single();
  if (importRowError || !importRow) {
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not resolve deck for import' });
    await maybeFinalizeImport(supabase, importId);
    return { claimed: true, jobId: job.id, error: 'import_missing' };
  }
  const deckId = importRow.deck_id as string;
  const mergedStackId = importRow.merged_stack_id as string | null;
  const stackName = `Page ${page.displayed_page_number ?? page.page_index + 1}`;

  const { data: existingVersions } = await supabase.from('stacks').select('version').eq('source_page_id', pageId).order('version', { ascending: false }).limit(1);
  const nextVersion = ((existingVersions?.[0]?.version as number | undefined) ?? 0) + 1;

  const { data: extractionRow, error: insertError } = await supabase
    .from('stacks')
    .insert({ source_page_id: pageId, deck_id: deckId, name: stackName, kind: 'page', version: nextVersion, status: 'processing', model: getConfiguredGeminiModel(), prompt_version: PROMPT_VERSION })
    .select()
    .single();
  if (insertError || !extractionRow) {
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not create stacks row' });
    await maybeFinalizeImport(supabase, importId);
    return { claimed: true, jobId: job.id, error: 'write_failed' };
  }

  const sourceLines = page.text ? toSourceLines(page.text) : [];
  const imageRegions = (Array.isArray(page.image_regions) ? page.image_regions : []) as ImageRegionInput[];
  // Best-effort: a page with no slice (pdf-lib couldn't parse the source
  // PDF, or the upload failed during preprocessing) still gets a text-only
  // extraction rather than failing the job — see sliceAndUploadPagePdf.
  const pagePdfBase64 = await loadPagePdfBase64(supabase, page.page_pdf_path as string | null);
  // 'application/pdf' for every page produced by the textbook-PDF pipeline;
  // a real image mime (e.g. 'image/png') for a plain-image source instead —
  // see visual_mime_type/processImageSourceImport in preprocessWorker.ts.
  const visualMimeType = (page.visual_mime_type as string | null) ?? 'application/pdf';
  // Faithful-mode-only, optional — shared by every page in this import (see
  // preprocessWorker.ts's ensureExtractionJobsExist); best-effort, same as
  // the page's own PDF slice — a failed download just means no card gets an
  // answer this run, never a failed job.
  const answerKeyBase64 = await loadAnswerKeyBase64(supabase, answerKeyStoragePath ?? null);
  const answerKey = answerKeyBase64 ? { mimeType: answerKeyMimeType ?? 'application/pdf', base64: answerKeyBase64 } : null;
  // Fetched fresh per job so every page sees whatever tags earlier pages
  // (including ones from other imports/units) have already contributed —
  // see TAGS in pageExtraction.ts.
  const { data: tagRows } = await supabase.from('tags').select('name').order('name');
  const existingTags = (tagRows ?? []).map((r) => r.name as string);
  const jobStarted = Date.now();

  const attempt = await runFullExtraction(sourceLines, imageRegions, pagePdfBase64, adminInstructions, isImageOnly, existingTags, visualMimeType, answerKey, isPromptOnly);
  if (!attempt.ok) {
    await supabase.from('stacks').update({ status: 'failed', raw_model_response: { attempts: attempt.raw }, updated_at: new Date().toISOString() }).eq('id', extractionRow.id);
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: attempt.error ?? 'extraction failed' });
    await maybeFinalizeImport(supabase, importId);
    return { claimed: true, jobId: job.id, error: attempt.error };
  }

  let blocks = attempt.blocks;
  let coverage = checkCoverage(sourceLines, blocks);
  const repairHistory: Record<string, unknown>[] = [];
  let auditResult: Record<string, unknown> | null = null;
  let modelWarnings = attempt.pageWarnings;

  const needsAudit = () => coverageHasIssues(coverage) || modelWarnings.length > 0;
  // A page can chain up to 1 (extraction) + 2x(audit+repair) calls; each
  // call already has its own hard timeout (see gemini.ts), but this caps
  // the *job's* total wall-clock too, well below the Edge Function platform
  // limit — remaining issues are simply left as unresolved_warnings rather
  // than the job running indefinitely.
  const withinJobBudget = () => Date.now() - jobStarted < JOB_TIME_BUDGET_MS;

  const pdfInlineData = pagePdfBase64 ? [{ mimeType: visualMimeType, base64: pagePdfBase64 }] : undefined;
  // The repair stage (unlike audit/polish) is where answer fields actually
  // get written/fixed, so it's the one other stage that needs the answer
  // key attached alongside the page's own slice.
  const repairInlineData = [...(pdfInlineData ?? []), ...(answerKey ? [{ mimeType: answerKey.mimeType, base64: answerKey.base64 }] : [])];

  for (let repairAttempt = 1; repairAttempt <= MAX_REPAIR_ATTEMPTS && needsAudit() && withinJobBudget(); repairAttempt++) {
    const auditOutcome = await callGemini({
      systemPrompt: COMPLETENESS_AUDIT_SYSTEM_PROMPT,
      userPrompt: buildAuditUserPrompt({
        numberedSourceLines: formatNumberedLines(sourceLines),
        imageRegions,
        pageExtractionJson: { blocks, page_warnings: modelWarnings },
        hasAdminInstructions: !!adminInstructions,
      }),
      inlineData: pdfInlineData,
    });
    if (!auditOutcome.ok) break;
    const parsedAudit = parseJsonContent(auditOutcome.content);
    if (!parsedAudit.ok || typeof parsedAudit.value !== 'object' || parsedAudit.value === null) break;
    auditResult = parsedAudit.value as Record<string, unknown>;

    // Translation completeness was never deterministically checked before —
    // only self-audited by the model, which is exactly why it silently went
    // missing on real pages. Fold the deterministic finding (coverage.ts)
    // into the audit result the repair call actually reads from, rather
    // than trusting the model to have caught it itself.
    if (coverage.missingTranslationOrderIndexes.length) {
      const existing = Array.isArray(auditResult.translation_issues) ? (auditResult.translation_issues as unknown[]) : [];
      auditResult.translation_issues = [...existing, `Blocks at order_index [${coverage.missingTranslationOrderIndexes.join(', ')}] have content but no translation — add one for each, without touching source_text.`];
      auditResult.passed = false;
    }

    const auditPassed = auditResult.passed === true;
    if (auditPassed && !coverageHasIssues(coverage)) break;

    const issuesBefore = [...coverageToWarnings(coverage), ...auditToWarnings(auditResult)].map((w) => w.message);

    const repairOutcome = await callGemini({
      systemPrompt: REPAIR_SYSTEM_PROMPT,
      userPrompt: buildRepairUserPrompt({
        numberedSourceLines: formatNumberedLines(sourceLines),
        imageRegions,
        currentExtractionJson: { blocks, page_warnings: modelWarnings },
        auditJson: auditResult,
        adminInstructions,
        hasAnswerKey: !!answerKey,
      }),
      inlineData: repairInlineData.length ? repairInlineData : undefined,
    });
    if (!repairOutcome.ok) break;
    const parsedRepair = parseJsonContent(repairOutcome.content);
    if (!parsedRepair.ok) break;
    const validatedRepair = validatePage(parsedRepair.value);
    if (!validatedRepair.ok || !validatedRepair.value) break;

    blocks = validatedRepair.value.blocks.map((b, i) => ({ ...b, order_index: i }));
    modelWarnings = validatedRepair.value.page_warnings;
    coverage = checkCoverage(sourceLines, blocks);

    repairHistory.push({
      attempt: repairAttempt,
      timestamp: new Date().toISOString(),
      issuesBefore,
      issuesAfter: [...coverageToWarnings(coverage), ...auditToWarnings(auditResult)].map((w) => w.message),
    });
  }

  // ---------- polish pass: composition quality, not fidelity ----------
  // Runs once, after the fidelity audit/repair loop above has already
  // settled wording/coverage — this stage's only job is "does this feel
  // like a premium, finished set of cards" (duplicate labels, fragment
  // cards, wrong recipe choice). Never allowed to fail the job: if the call
  // errors, returns invalid JSON, or fails validation, the pre-polish
  // blocks are simply used as-is.
  let polishApplied = false;
  const polishOutcome = await callGemini({
    systemPrompt: POLISH_SYSTEM_PROMPT,
    userPrompt: buildPolishUserPrompt({ currentExtractionJson: { blocks, page_warnings: modelWarnings }, existingTags }),
    inlineData: pdfInlineData,
  });
  if (polishOutcome.ok) {
    const parsedPolish = parseJsonContent(polishOutcome.content);
    if (parsedPolish.ok) {
      const validatedPolish = validatePage(parsedPolish.value);
      if (validatedPolish.ok && validatedPolish.value) {
        blocks = validatedPolish.value.blocks.map((b, i) => ({ ...b, order_index: i }));
        modelWarnings = validatedPolish.value.page_warnings;
        coverage = checkCoverage(sourceLines, blocks);
        polishApplied = true;
      }
    }
  }

  // Deterministic line-coverage gaps are only a real fidelity problem in the
  // default, unshaped-extraction case. Once an admin prompt is steering
  // extraction, "every source line must appear on a card" stops being a
  // valid correctness signal — the admin may have deliberately asked to
  // skip content — so those gaps are dropped from unresolved_warnings
  // entirely rather than surfaced as a caution badge for something that's
  // working exactly as instructed. The repair pass above still sees them
  // (and already receives adminInstructions itself, so it can reason about
  // whether a gap is intentional) — only the final surfaced warnings change.
  const unresolvedWarnings = [
    ...(adminInstructions ? [] : coverageToWarnings(coverage)),
    ...modelWarnings.map((w) => ({ code: w.code, message: w.message, source_line_ids: w.source_line_ids })),
  ];

  // Purely-visual fields derived deterministically rather than asked of the
  // model: this pass still never captures answer keys or wires real audio
  // matching (answer_key_status/activity_audio_reference stay at their DB
  // defaults), and the pronunciation icon (spec section 9A) only makes sense
  // for French document/interaction text.
  const isFrench = (attempt.detectedLanguage ?? '').toLowerCase().startsWith('fr');

  // When merged, every page in the import files its cards under the same
  // shared stack — order_index alone would then collide across pages (each
  // page's own blocks start back at 0), so it's offset by this page's
  // global position to keep merged cards in the right overall order. Not
  // needed (and not applied) for the ordinary unmerged case, where a stack
  // only ever holds one page's blocks to begin with.
  const cardStackId = mergedStackId ?? extractionRow.id;
  const orderOffset = mergedStackId ? page.page_index * 1000 : 0;

  const { error: blocksInsertError } = await supabase.from('cards').insert(
    blocks.map((b) => ({
      stack_id: cardStackId,
      source_page_id: pageId,
      deck_id: deckId,
      origin: 'textbook_extraction',
      order_index: orderOffset + b.order_index,
      block_kind: b.kind,
      component_type: b.component_type,
      section_number: b.section_number,
      title: b.title,
      instruction: b.instruction,
      language: attempt.detectedLanguage,
      pronunciation_enabled: isFrench && (b.kind === 'document' || b.kind === 'interaction'),
      source_line_ids: b.source_line_ids,
      source_text: b.source_text,
      content: b.content,
      translation: b.translation,
      category: b.category,
      tags: b.tags,
      needs_review: b.needs_review,
      review_reason: b.review_reason,
      answer_key_status: b.answer_key_status,
      prompt_generated: !!adminInstructions,
      include_in_practice: false,
    })),
  );
  if (blocksInsertError) {
    await supabase.from('stacks').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', extractionRow.id);
    await supabase.rpc('fail_job', { p_job_id: job.id, p_error: 'could not store extracted blocks' });
    await maybeFinalizeImport(supabase, importId);
    return { claimed: true, jobId: job.id, error: 'write_failed' };
  }

  // Grow the shared pool with any genuinely new tag the model proposed —
  // upsert rather than insert so a tag another concurrent page job just
  // added never causes a duplicate-key error here.
  const newTags = [...new Set(blocks.flatMap((b) => b.tags))].filter((t) => !existingTags.includes(t));
  if (newTags.length) {
    await supabase
      .from('tags')
      .upsert(
        newTags.map((name) => ({ name })),
        { onConflict: 'name', ignoreDuplicates: true },
      );
  }

  await supabase
    .from('stacks')
    .update({
      status: 'needs_review',
      model: attempt.model,
      raw_model_response: { attempts: attempt.raw },
      model_warnings: modelWarnings,
      coverage_result: coverage,
      audit_result: auditResult,
      repair_history: repairHistory,
      unresolved_warnings: unresolvedWarnings,
      updated_at: new Date().toISOString(),
    })
    .eq('id', extractionRow.id);

  await supabase.rpc('complete_job', {
    p_job_id: job.id,
    p_result: {
      page_extraction_id: extractionRow.id,
      version: nextVersion,
      blocks_written: blocks.length,
      model: attempt.model,
      usage: attempt.usage,
      latency_ms: attempt.totalLatencyMs,
      unresolved_warning_count: unresolvedWarnings.length,
      repair_attempts: repairHistory.length,
      polish_applied: polishApplied,
    },
  });

  await maybeFinalizeImport(supabase, importId);

  return { claimed: true, jobId: job.id };
}

export async function processOneExtractionJob(supabase: SupabaseClient): Promise<ExtractResult> {
  const { data: claimed, error: claimError } = await supabase.rpc('claim_jobs', { p_type: 'extract_page', p_limit: 1 });
  if (claimError) return { claimed: false, error: claimError.message };
  if (!claimed || claimed.length === 0) return { claimed: false };
  return processClaimedExtractionJob(supabase, claimed[0] as ExtractJobRow);
}

/**
 * Claims up to `batchSize` extract_page jobs in one atomic RPC call, then
 * processes all of them concurrently (Promise.all) instead of one at a
 * time. Every page's extraction is fully independent of every other page's
 * (own Gemini calls, own page_extractions row, own block inserts), so
 * there's no correctness reason to serialize them — the old one-job-per-
 * dispatcher-loop-iteration shape was leaving that concurrency on the
 * table. maybeFinalizeImport (called once per job, inside
 * processClaimedExtractionJob) is safe to run concurrently for the same
 * import: worst case two jobs finishing at nearly the same instant both
 * compute and write the same final status, which is a harmless duplicate
 * write, not a correctness issue.
 */
export async function processExtractionJobsBatch(supabase: SupabaseClient, batchSize: number): Promise<ExtractResult[]> {
  const { data: claimed, error: claimError } = await supabase.rpc('claim_jobs', { p_type: 'extract_page', p_limit: batchSize });
  if (claimError) return [{ claimed: false, error: claimError.message }];
  if (!claimed || claimed.length === 0) return [];
  return Promise.all((claimed as ExtractJobRow[]).map((job) => processClaimedExtractionJob(supabase, job)));
}
