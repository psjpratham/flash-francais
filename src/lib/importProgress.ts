import { getExtractionProgress, getPageReviewCounts } from './pageExtractions';
import { getImportById, getLatestFailedPreprocessingPage, IMPORT_SOURCES, listImportFiles } from './imports';
import type { ImportErrorCategory } from './importErrors';
import type { ImportSourceType } from '../types';

/** One unified status vocabulary for every import type — never a raw job status or RPC name. */
export type ImportProgressStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

/** User-facing stage labels — never "idle", a job status, or Edge Function terminology. The page is the only content unit: no chapter/lesson/section wording anywhere here. */
export const STAGE = {
  PREPARING: 'Preparing',
  UPLOADING: 'Uploading',
  READING: 'Reading pages',
  EXTRACTING: 'Extracting pages',
  VALIDATING: 'Final validation',
  READY: 'Ready',
} as const;

/** A non-terminal import with no persisted progress in this long is presumed stuck — surfaced as a warning, never silently ignored. */
export const NO_PROGRESS_WARNING_MS = 5 * 60 * 1000;

export interface ImportProgress {
  status: ImportProgressStatus;
  currentStage: string;
  totalUnits: number | null;
  completedUnits: number;
  failedUnits: number;
  /** 0-100, computed from persisted counts per fixed bands (Uploading 0-10, Preparing 10-35, Extracting 35-95, Validating 95-100) — never fabricated. */
  percent: number;
  /** True when this stage's real total isn't known yet — render an indeterminate bar, not a fabricated percent. */
  indeterminate: boolean;
  message: string;
  /** Extraction jobs stuck in 'processing' well past a sane threshold — never silently folded into "processing". */
  staleUnits?: number;
  /** True when status is non-terminal but last_progress_at is stale — "No progress for N minutes". */
  noProgressMinutes?: number;
  errorCategory?: ImportErrorCategory;
  errorDetail?: string;
}

export type SourceFileState = 'not_provided' | 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface SourceFileStatus {
  type: ImportSourceType;
  label: string;
  required: boolean;
  state: SourceFileState;
  filename?: string;
  error?: string;
}

export interface TextbookImportProgress extends ImportProgress {
  sourceFiles: SourceFileStatus[];
  /** Populated once extraction is done — per-page review status, for the "Review pages" summary line. */
  reviewCounts?: { needsReview: number; approved: number; failed: number; pending: number };
}

function sourceFileStatuses(files: Awaited<ReturnType<typeof listImportFiles>>): SourceFileStatus[] {
  const bySource = new Map(files.map((f) => [f.source_type, f]));
  return IMPORT_SOURCES.map((s) => {
    const f = bySource.get(s.type);
    if (!f) return { type: s.type, label: s.label, required: s.required, state: 'not_provided' as const };
    const state: SourceFileState =
      f.status === 'completed' ? 'uploaded' : f.status === 'failed' ? 'failed' : f.status === 'uploading' ? 'uploading' : 'pending';
    return { type: s.type, label: s.label, required: s.required, state, filename: f.filename, error: f.error ?? undefined };
  });
}

function noProgressMinutes(lastProgressAt: string | null): number | undefined {
  if (!lastProgressAt) return undefined;
  const elapsedMs = Date.now() - new Date(lastProgressAt).getTime();
  return elapsedMs >= NO_PROGRESS_WARNING_MS ? Math.floor(elapsedMs / 60000) : undefined;
}

/**
 * Reconstructs full textbook-import progress purely from persisted state —
 * the `imports` row (status + progress columns, written only by the
 * server-side dispatcher/workers) plus derived job/review counts. A pure
 * read: never creates a job, never triggers work, never assumes a browser
 * drove any of this. Safe to call on a fresh page load with no prior
 * client-side state at all.
 */
export async function computeTextbookImportProgress(importId: string): Promise<TextbookImportProgress> {
  const [imp, files] = await Promise.all([getImportById(importId), listImportFiles(importId)]);
  const sourceFiles = sourceFileStatuses(files);
  const textbookFile = files.find((f) => f.source_type === 'textbook');
  const stale = noProgressMinutes(imp.last_progress_at);

  if (!textbookFile) {
    return {
      status: 'pending',
      currentStage: STAGE.PREPARING,
      totalUnits: null,
      completedUnits: 0,
      failedUnits: 0,
      percent: 0,
      indeterminate: false,
      message: 'Choose a textbook PDF to begin.',
      sourceFiles,
    };
  }

  // ---------- stage 1: uploading (0-10%) ----------
  if (textbookFile.status !== 'completed') {
    if (textbookFile.status === 'failed') {
      return {
        status: 'failed',
        currentStage: STAGE.UPLOADING,
        totalUnits: 1,
        completedUnits: 0,
        failedUnits: 1,
        percent: 0,
        indeterminate: false,
        message: 'The textbook file failed to upload.',
        errorDetail: textbookFile.error ?? undefined,
        sourceFiles,
      };
    }
    return {
      status: 'running',
      currentStage: STAGE.UPLOADING,
      totalUnits: 1,
      completedUnits: 0,
      failedUnits: 0,
      percent: textbookFile.status === 'uploading' ? 5 : 0,
      indeterminate: false,
      message: 'Uploading the textbook file…',
      sourceFiles,
    };
  }

  // ---------- terminal states ----------
  if (imp.status === 'failed') {
    return {
      status: 'failed',
      currentStage: imp.preprocessing_error ? STAGE.READING : STAGE.EXTRACTING,
      totalUnits: imp.total_pages,
      completedUnits: imp.pages_prepared,
      failedUnits: imp.pages_failed_preprocessing,
      percent: imp.preprocessing_error ? 10 : 35,
      indeterminate: false,
      message: imp.preprocessing_error ?? 'The import failed.',
      errorDetail: imp.preprocessing_error ?? undefined,
      sourceFiles,
      noProgressMinutes: stale,
    };
  }
  if (imp.status === 'needs_review' || imp.status === 'completed' || imp.status === 'completed_with_errors') {
    const reviewCounts = await getPageReviewCounts(importId);
    const jobs = await getExtractionProgress(importId);
    const label = imp.status === 'completed' ? 'Completed — every page reviewed and approved.' : imp.status === 'completed_with_errors' ? `Completed with errors — ${jobs.failed} page(s) failed and can be retried.` : `Ready for page review — ${reviewCounts.needsReview} page(s) need review, ${reviewCounts.approved} approved.`;
    return {
      status: imp.status === 'completed' ? 'completed' : imp.status === 'completed_with_errors' ? 'completed_with_errors' : 'completed',
      currentStage: STAGE.READY,
      totalUnits: imp.total_pages,
      completedUnits: jobs.completed,
      failedUnits: jobs.failed,
      percent: 100,
      indeterminate: false,
      message: label,
      sourceFiles,
      reviewCounts,
    };
  }

  // ---------- stage 2: reading/preparing pages (10-35%) ----------
  if (imp.status === 'uploaded' || imp.status === 'preprocessing') {
    if (imp.total_pages == null) {
      return {
        status: 'running',
        currentStage: STAGE.READING,
        totalUnits: null,
        completedUnits: 0,
        failedUnits: 0,
        percent: 10,
        indeterminate: true,
        message: imp.status === 'uploaded' ? 'Waiting to start reading pages…' : 'Reading PDF metadata…',
        sourceFiles,
        noProgressMinutes: stale,
      };
    }
    const donePortion = imp.total_pages > 0 ? imp.pages_discovered / imp.total_pages : 0;
    const remaining = Math.max(0, imp.total_pages - imp.pages_discovered);
    const currentPageLabel = imp.current_page_index != null ? `Reading page ${imp.current_page_index + 1} of ${imp.total_pages}` : `Found ${imp.total_pages} page(s)`;
    const counts = `${imp.pages_prepared} prepared · ${imp.pages_failed_preprocessing} failed · ${remaining} remaining`;

    let message = `${currentPageLabel} · ${counts}`;
    if (imp.pages_failed_preprocessing > 0) {
      const latestFailed = await getLatestFailedPreprocessingPage(importId).catch(() => null);
      if (latestFailed) {
        const nextPage = imp.current_page_index != null ? imp.current_page_index + 1 : latestFailed.displayedPageNumber + 1;
        message = `Page ${latestFailed.displayedPageNumber} failed: ${latestFailed.error}. Continuing with page ${nextPage}. · ${counts}`;
      }
    }

    return {
      status: 'running',
      currentStage: STAGE.READING,
      totalUnits: imp.total_pages,
      completedUnits: imp.pages_discovered,
      failedUnits: imp.pages_failed_preprocessing,
      percent: Math.round(10 + donePortion * 25),
      indeterminate: false,
      message,
      sourceFiles,
      noProgressMinutes: stale,
    };
  }

  // ---------- stage 3: extracting pages (35-95%) ----------
  const jobs = await getExtractionProgress(importId);
  if (jobs.total === 0) {
    return {
      status: 'running',
      currentStage: STAGE.EXTRACTING,
      totalUnits: imp.pages_prepared || null,
      completedUnits: 0,
      failedUnits: 0,
      percent: 35,
      indeterminate: true,
      message: 'Starting page extraction…',
      sourceFiles,
      noProgressMinutes: stale,
    };
  }
  const donePortion = (jobs.completed + jobs.failed) / jobs.total;
  const counts = [`${jobs.completed} of ${jobs.total} pages extracted`];
  if (jobs.failed > 0) counts.push(`${jobs.failed} failed`);
  if (jobs.queued > 0) counts.push(`${jobs.queued} queued`);
  const activelyProcessing = jobs.processing - jobs.stale;
  if (activelyProcessing > 0) counts.push(`${activelyProcessing} processing`);

  let message: string;
  if (jobs.stale > 0) {
    message = `Stuck job detected — ${jobs.stale} page(s) have been processing too long and may need requeuing. ${counts.join(' · ')}.`;
  } else {
    message = `${counts.join(' · ')}.`;
  }

  return {
    status: 'running',
    currentStage: donePortion >= 1 ? STAGE.VALIDATING : STAGE.EXTRACTING,
    totalUnits: jobs.total,
    completedUnits: jobs.completed,
    failedUnits: jobs.failed,
    staleUnits: jobs.stale,
    percent: Math.round(35 + Math.min(donePortion, 1) * 60),
    indeterminate: false,
    message,
    sourceFiles,
    noProgressMinutes: stale,
  };
}

/** True once every automatable stage has reached a terminal outcome. */
export function isTerminal(status: ImportProgressStatus): boolean {
  return status === 'completed' || status === 'completed_with_errors' || status === 'failed';
}
