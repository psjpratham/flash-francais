import { listImportPages, getImportById, listImportFiles } from './imports';
import { getPageReviewCounts, listExtractionJobs, type ExtractionJobDetail } from './pageExtractions';
import { computeTextbookImportProgress, type ImportProgressStatus } from './importProgress';

/**
 * Everything an admin needs to see about one textbook import, beyond the
 * plain user-facing progress bar. Never fetched or rendered for non-owners
 * — see the isAdmin gate in the import page. Deliberately excludes secrets,
 * auth tokens, and full source text (only filenames and counts) — safe to
 * copy verbatim as diagnostics JSON.
 */
export interface ImportDiagnostics {
  importId: string;
  deckId: string;
  status: ImportProgressStatus;
  currentStage: string;
  createdAt: string;
  lastUpdatedAt: string;
  elapsedMs: number;
  noProgressMinutes: number | undefined;
  uploadedFileNames: string[];
  // ---------- preprocessing ----------
  totalPages: number | null;
  pagesDiscovered: number;
  pagesPrepared: number;
  pagesFailedPreprocessing: number;
  currentPageIndex: number | null;
  pagesRendered: number;
  preprocessingError: string | null;
  // ---------- extraction ----------
  reviewCounts: { needsReview: number; approved: number; failed: number; pending: number };
  /** One row per page — page number joined onto its extraction job for the admin table (never call this "a lesson"). */
  jobs: (ExtractionJobDetail & { pageIndex: number | null; displayedPageNumber: number | null })[];
}

export async function computeImportDiagnostics(importId: string): Promise<ImportDiagnostics> {
  const [imp, files, jobs, pages, reviewCounts, progress] = await Promise.all([
    getImportById(importId),
    listImportFiles(importId),
    listExtractionJobs(importId),
    listImportPages(importId),
    getPageReviewCounts(importId),
    computeTextbookImportProgress(importId),
  ]);

  const timestamps = [
    imp.created_at,
    ...jobs.flatMap((j) => [j.createdAt, j.startedAt, j.completedAt].filter((t): t is string => !!t)),
  ];
  const lastUpdatedAt = timestamps.reduce((latest, t) => (new Date(t).getTime() > new Date(latest).getTime() ? t : latest), imp.created_at);

  const pageById = new Map(pages.map((p) => [p.id, p]));
  const jobsWithPageInfo = jobs.map((j) => {
    const page = pageById.get(j.pageId);
    return { ...j, pageIndex: page?.page_index ?? null, displayedPageNumber: page?.displayed_page_number ?? null };
  });

  return {
    importId,
    deckId: imp.deck_id,
    status: progress.status,
    currentStage: progress.currentStage,
    createdAt: imp.created_at,
    lastUpdatedAt,
    elapsedMs: Date.now() - new Date(imp.created_at).getTime(),
    noProgressMinutes: progress.noProgressMinutes,
    uploadedFileNames: files.filter((f) => f.status === 'completed').map((f) => f.filename),
    totalPages: imp.total_pages,
    pagesDiscovered: imp.pages_discovered,
    pagesPrepared: imp.pages_prepared,
    pagesFailedPreprocessing: imp.pages_failed_preprocessing,
    currentPageIndex: imp.current_page_index,
    pagesRendered: pages.filter((p) => p.rendered_page_path).length,
    preprocessingError: imp.preprocessing_error,
    reviewCounts,
    jobs: jobsWithPageInfo,
  };
}
