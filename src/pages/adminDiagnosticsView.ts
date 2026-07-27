import type { ExtractionJobDetail } from '../lib/pageExtractions';
import type { ImportDiagnostics } from '../lib/importDiagnostics';
import { esc } from '../lib/dom';

type JobRowData = ExtractionJobDetail & { pageIndex: number | null; displayedPageNumber: number | null };

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function statusBadge(job: ExtractionJobDetail): string {
  if (job.isStale) return `<span class="diag-badge stale">Stale</span>`;
  return `<span class="diag-badge ${job.status}">${esc(job.status)}</span>`;
}

function pageLabel(job: JobRowData): string {
  if (job.displayedPageNumber != null) return `Page ${job.displayedPageNumber}`;
  if (job.pageIndex != null) return `Page ${job.pageIndex + 1}`;
  return '—';
}

function jobRow(job: JobRowData): string {
  return `
    <tr data-job-id="${job.id}">
      <td>${esc(pageLabel(job))}</td>
      <td>${statusBadge(job)}</td>
      <td>${job.attemptCount}</td>
      <td>${fmtTime(job.createdAt)}</td>
      <td>${fmtTime(job.startedAt)}</td>
      <td>${fmtTime(job.completedAt)}</td>
      <td>${fmtDuration(job.elapsedMs)}</td>
      <td>${job.model ? esc(job.model) : '—'}</td>
      <td>${job.promptTokens ?? '—'}</td>
      <td>${job.completionTokens ?? '—'}</td>
      <td>${job.blocksWritten ?? '—'}</td>
      <td>${job.unresolvedWarningCount ?? '—'}</td>
      <td>${job.repairAttempts ?? '—'}</td>
      <td class="wrap">${job.error ? esc(job.error) : '—'}</td>
      <td>${job.status === 'failed' ? `<button class="btn-sec" data-retry-job="${job.id}">Retry</button>` : ''}</td>
    </tr>`;
}

/** Admin/owner-only deep-dive — never rendered for a non-owner (gated by the caller, not by this function). One row per page job, never called a "lesson" or "chunk". */
export function renderAdminDiagnostics(d: ImportDiagnostics): string {
  return `
    <div class="diag-summary">
      <div><span>Import ID</span>${esc(d.importId)}</div>
      <div><span>Deck ID</span>${esc(d.deckId)}</div>
      <div><span>Status</span>${esc(d.status)}</div>
      <div><span>Current stage</span>${esc(d.currentStage)}</div>
      <div><span>Created</span>${fmtTime(d.createdAt)}</div>
      <div><span>Last updated</span>${fmtTime(d.lastUpdatedAt)}</div>
      <div><span>Elapsed</span>${fmtDuration(d.elapsedMs)}</div>
      ${d.noProgressMinutes != null ? `<div><span>⚠️ No progress for</span>${d.noProgressMinutes} min</div>` : ''}
      <div><span>Uploaded files</span>${d.uploadedFileNames.length ? d.uploadedFileNames.map(esc).join(', ') : '—'}</div>
    </div>
    <div class="diag-summary">
      <div><span>Total pages</span>${d.totalPages ?? '?'}</div>
      <div><span>Pages discovered</span>${d.pagesDiscovered}</div>
      <div><span>Pages prepared</span>${d.pagesPrepared}</div>
      <div><span>Pages with no text</span>${d.pagesFailedPreprocessing}</div>
      <div><span>Current/last page</span>${d.currentPageIndex != null ? `Page ${d.currentPageIndex + 1}` : '—'}</div>
      <div><span>Pages rendered</span>${d.pagesRendered} / ${d.totalPages ?? '?'}</div>
      ${d.preprocessingError ? `<div><span>Preprocessing error</span>${esc(d.preprocessingError)}</div>` : ''}
      <div><span>Review status</span>${d.reviewCounts.approved} approved · ${d.reviewCounts.needsReview} need review · ${d.reviewCounts.failed} failed · ${d.reviewCounts.pending} pending</div>
    </div>
    <div class="diag-table-wrap">
      <table class="diag-table">
        <thead>
          <tr>
            <th>Page</th><th>Status</th><th>Attempts</th><th>Created</th><th>Started</th><th>Finished</th>
            <th>Elapsed</th><th>Model</th><th>Prompt tok</th><th>Compl. tok</th><th>Blocks</th><th>Warnings</th><th>Repairs</th><th>Error</th><th></th>
          </tr>
        </thead>
        <tbody>${d.jobs.map(jobRow).join('')}</tbody>
      </table>
    </div>`;
}
