import { computeImportDiagnostics, type ImportDiagnostics } from '../lib/importDiagnostics';
import { getImportById, hasActivePreprocessJob, resumePreprocessing, retryFailedPreprocessingPages } from '../lib/imports';
import { startImportPolling } from '../lib/importPolling';
import { computeTextbookImportProgress, isTerminal, STAGE, type TextbookImportProgress } from '../lib/importProgress';
import { hasAnyPageExtractions, requeueStaleExtractionJobs, retryFailedExtractionJobs, retryOneExtractionJob } from '../lib/pageExtractions';
import { renderPendingPageImages } from '../lib/pageRender';
import type { Import } from '../types';
import { $, errMsg, esc, toast } from '../lib/dom';
import { renderImportProgress } from './importProgressView';
import { renderAdminJobsTable, renderImportDetailsSummary } from './adminDiagnosticsView';

export interface ImportDetailDeps {
  onBack: () => void;
  onOpenPageReview: (importId: string) => void;
  deckId: string;
  deckName: string;
  importId: string;
  /** Gates only the extra model/token/cost deep-dive (renderAdminJobsTable) + "Requeue stale jobs"/"Copy diagnostics JSON" — the plain-language details summary and every self-service retry/resume action are available to any owner, admin or not. */
  isAdmin: boolean;
}

/**
 * The durable, permanent home for one import — reachable by import_id alone,
 * reconstructs everything from Supabase, and never drives work itself (see
 * src/lib/importProgress.ts's pure-read contract). Polls persisted progress
 * on an interval; navigating away just stops the poll, it never cancels
 * anything server-side, because nothing server-side depends on this page
 * being open in the first place.
 *
 * Returns a dispose function — callers must invoke it when navigating away
 * to stop the polling interval (same pattern as renderSession).
 */
export function renderImportDetail(container: HTMLElement, deps: ImportDetailDeps): () => void {
  let imp: Import | null = null;
  let progress: TextbookImportProgress | null = null;
  let loadError: string | null = null;
  let pagesReady = false;

  /** Toggles the "Details" panel — visible to any owner; deps.isAdmin only adds the extra model/token table inside it once open. */
  let showDetails = false;
  let diagnostics: ImportDiagnostics | null = null;
  let diagBusy = false;
  let diagError: string | null = null;
  let hasActiveJob = false;
  let preprocessBusy = false;

  let stopPolling: (() => void) | null = null;

  // ---------- init ----------

  async function init(): Promise<void> {
    try {
      imp = await getImportById(deps.importId);
    } catch (e) {
      loadError = 'Could not load this import: ' + errMsg(e);
      render();
      return;
    }
    pagesReady = await hasAnyPageExtractions(deps.importId).catch(() => false);
    hasActiveJob = await hasActivePreprocessJob(deps.importId).catch(() => false);
    stopPolling = startImportPolling(deps.importId, onProgress);
    // Warms the rendered-page cache while the admin is on this screen, so
    // images are likely already there by the time they open page review —
    // page rasterization needs a real <canvas>, so it can only run here in
    // the browser, never on the server-side dispatcher.
    void renderPendingPageImages(deps.importId).catch(() => {
      /* best-effort — pageReview.ts retries this itself when opened */
    });
  }

  async function onProgress(p: TextbookImportProgress): Promise<void> {
    progress = p;
    pagesReady = pagesReady || (await hasAnyPageExtractions(deps.importId).catch(() => pagesReady));
    if (p.currentStage === STAGE.READING) {
      hasActiveJob = await hasActivePreprocessJob(deps.importId).catch(() => hasActiveJob);
    }
    render();
  }

  async function refreshNow(): Promise<void> {
    try {
      imp = await getImportById(deps.importId);
      hasActiveJob = await hasActivePreprocessJob(deps.importId).catch(() => hasActiveJob);
    } catch {
      /* keep showing the last known state */
    }
    render();
  }

  // ---------- preprocessing controls (resume / retry failed pages) ----------

  async function runResumePreprocessing(): Promise<void> {
    if (preprocessBusy || hasActiveJob) return;
    preprocessBusy = true;
    render();
    try {
      await resumePreprocessing(deps.importId, deps.deckId);
      toast('Preprocessing resumed');
      hasActiveJob = true;
      await refreshNow();
    } catch (e) {
      toast('Could not resume preprocessing: ' + errMsg(e));
    } finally {
      preprocessBusy = false;
      render();
    }
  }

  async function runRetryFailedPreprocessingPages(): Promise<void> {
    if (preprocessBusy || hasActiveJob) return;
    preprocessBusy = true;
    render();
    try {
      const n = await retryFailedPreprocessingPages(deps.importId, deps.deckId);
      toast(n > 0 ? `Re-queued ${n} failed page(s)` : 'No failed pages to retry');
      if (n > 0) hasActiveJob = true;
      await refreshNow();
    } catch (e) {
      toast('Could not retry failed pages: ' + errMsg(e));
    } finally {
      preprocessBusy = false;
      render();
    }
  }

  // ---------- details panel + retry controls ----------

  async function loadDiagnostics(): Promise<void> {
    diagError = null;
    try {
      diagnostics = await computeImportDiagnostics(deps.importId);
    } catch (e) {
      diagError = 'Could not load diagnostics: ' + errMsg(e);
    }
    render();
  }

  async function toggleDetails(): Promise<void> {
    showDetails = !showDetails;
    render();
    if (showDetails && !diagnostics) await loadDiagnostics();
  }

  /** Self-service — any owner can retry their own failed extraction pages, not just admins. Refreshes `progress` (so the button's own visibility count is current) and, if the Details panel happens to be open, the fuller diagnostics too. */
  async function runRetryAllFailed(): Promise<void> {
    if (diagBusy) return;
    diagBusy = true;
    render();
    try {
      const n = await retryFailedExtractionJobs(deps.importId);
      toast(n > 0 ? `Requeued ${n} failed page(s)` : 'No failed pages to retry');
      progress = await computeTextbookImportProgress(deps.importId);
      if (diagnostics) await loadDiagnostics();
    } catch (e) {
      toast('Could not retry failed pages: ' + errMsg(e));
    } finally {
      diagBusy = false;
      render();
    }
  }

  async function runRetryOneJob(jobId: string): Promise<void> {
    if (diagBusy) return;
    diagBusy = true;
    render();
    try {
      await retryOneExtractionJob(jobId);
      await loadDiagnostics();
    } catch (e) {
      toast('Could not retry page: ' + errMsg(e));
    } finally {
      diagBusy = false;
      render();
    }
  }

  async function runRequeueStale(): Promise<void> {
    if (diagBusy) return;
    diagBusy = true;
    render();
    try {
      const n = await requeueStaleExtractionJobs(deps.importId);
      toast(n > 0 ? `Requeued ${n} stuck job(s)` : 'No stale jobs to requeue');
      await loadDiagnostics();
    } catch (e) {
      toast('Could not requeue stale jobs: ' + errMsg(e));
    } finally {
      diagBusy = false;
      render();
    }
  }

  async function copyDiagnostics(): Promise<void> {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      toast('Diagnostics copied');
    } catch (e) {
      toast('Could not copy: ' + errMsg(e));
    }
  }

  function renderDetailsSection(): string {
    return `
      <div class="panelbox">
        <button class="more-toggle" id="toggleDetailsBtn">${showDetails ? '− Hide details' : '+ Details'}</button>
        ${
          showDetails
            ? `<div style="margin-top:12px">
                 ${diagError ? `<div class="auth-err">${esc(diagError)}</div>` : ''}
                 <div class="row" style="margin-bottom:12px">
                   <button class="btn-sec" id="refreshDiagBtn" ${diagBusy ? 'disabled' : ''}>🔄 Refresh status</button>
                   ${pagesReady ? `<button class="btn-sec" id="diagOpenReviewBtn">📄 Open page review</button>` : ''}
                   ${deps.isAdmin ? `<button class="btn-sec" id="requeueStaleBtn" ${diagBusy ? 'disabled' : ''}>Requeue stale jobs</button>` : ''}
                   ${deps.isAdmin ? `<button class="btn-sec" id="copyDiagBtn">Copy admin diagnostics JSON</button>` : ''}
                 </div>
                 ${diagnostics ? renderImportDetailsSummary(diagnostics) : `<p class="p-text">Loading details…</p>`}
                 ${deps.isAdmin && diagnostics ? renderAdminJobsTable(diagnostics) : ''}
               </div>`
            : ''
        }
      </div>`;
  }

  function wireDiagnostics(): void {
    document.getElementById('toggleDetailsBtn')?.addEventListener('click', () => void toggleDetails());
    document.getElementById('refreshDiagBtn')?.addEventListener('click', () => {
      void refreshNow();
      void loadDiagnostics();
    });
    document.getElementById('diagOpenReviewBtn')?.addEventListener('click', () => deps.onOpenPageReview(deps.importId));
    document.getElementById('requeueStaleBtn')?.addEventListener('click', () => void runRequeueStale());
    document.getElementById('copyDiagBtn')?.addEventListener('click', () => void copyDiagnostics());
    document.querySelectorAll<HTMLButtonElement>('[data-retry-job]').forEach((btn) => {
      btn.addEventListener('click', () => void runRetryOneJob(btn.dataset.retryJob!));
    });
  }

  // ---------- render ----------

  function render(): void {
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← ${esc(deps.deckName)}</button>
        <div class="page-h">
          <h1>${imp ? esc(imp.title) : 'Import'}</h1>
          <p>Source import for <strong>${esc(deps.deckName)}</strong>.</p>
        </div>
        <div id="importBody"></div>
      </div>`;
    $(container, '#backBtn').addEventListener('click', () => {
      stopPolling?.();
      deps.onBack();
    });
    renderBody();
  }

  function renderBody(): void {
    const el = document.getElementById('importBody');
    if (!el) return;
    if (loadError) {
      el.innerHTML = `<div class="panelbox"><div class="auth-err">${esc(loadError)}</div></div>`;
      return;
    }
    if (!imp || !progress) {
      el.innerHTML = `<div class="panelbox"><p class="p-text">Loading import status…</p></div>`;
      return;
    }

    const showOpenReview = pagesReady;
    const preprocessingUnfinished = imp.status === 'uploaded' || imp.status === 'preprocessing' || (imp.status === 'failed' && !!imp.preprocessing_error);
    const showResume = preprocessingUnfinished && !hasActiveJob;
    const showRetryFailedPages = imp.pages_failed_preprocessing > 0 && !hasActiveJob;
    const failedExtractionCount = progress.reviewCounts?.failed ?? 0;
    const showRetryFailedExtraction = failedExtractionCount > 0;

    el.innerHTML = `
      <div class="panelbox">
        <h3>Progress</h3>
        ${renderImportProgress(progress, { compact: true })}
        ${
          preprocessingUnfinished && !hasActiveJob
            ? `<div class="auth-err">⚠ No preprocessing worker is currently active for this import.</div>`
            : ''
        }
        <div class="row">
          ${!isTerminal(progress.status) ? `<span class="p-text" style="color:var(--ink-faint)">Updating automatically…</span>` : ''}
          <button class="btn-sec" id="refreshStatusBtn" ${preprocessBusy ? 'disabled' : ''}>🔄 Refresh status</button>
          ${showResume ? `<button class="btn-sec" id="resumePreprocessBtn" ${preprocessBusy ? 'disabled' : ''}>▶ Resume preprocessing</button>` : ''}
          ${showRetryFailedPages ? `<button class="btn-sec" id="retryFailedPagesBtn" ${preprocessBusy ? 'disabled' : ''}>Retry failed pages (${imp.pages_failed_preprocessing})</button>` : ''}
          ${showRetryFailedExtraction ? `<button class="btn-sec" id="retryFailedExtractionBtn" ${diagBusy ? 'disabled' : ''}>Retry failed extraction (${failedExtractionCount})</button>` : ''}
          ${showOpenReview ? `<button class="btn-sec" id="openReviewBtn">📄 Open page review</button>` : ''}
        </div>
      </div>
      ${renderDetailsSection()}`;

    document.getElementById('openReviewBtn')?.addEventListener('click', () => deps.onOpenPageReview(deps.importId));
    document.getElementById('refreshStatusBtn')?.addEventListener('click', () => void refreshNow());
    document.getElementById('resumePreprocessBtn')?.addEventListener('click', () => void runResumePreprocessing());
    document.getElementById('retryFailedPagesBtn')?.addEventListener('click', () => void runRetryFailedPreprocessingPages());
    document.getElementById('retryFailedExtractionBtn')?.addEventListener('click', () => void runRetryAllFailed());
    wireDiagnostics();
  }

  render();
  void init();

  return () => {
    stopPolling?.();
  };
}
