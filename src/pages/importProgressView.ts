import type { ImportProgress } from '../lib/importProgress';
import { esc } from '../lib/dom';

/**
 * The one progress bar used by every import type (textbook or cards/JSON) —
 * same shape, same wording.
 *
 * `compact` (used by the textbook import-detail page, which has its own
 * gated Details panel right below) drops the raw job-queue message and the
 * "N / M done" line while a stage is still running — the headline here is
 * just stage + percentage, like a loading indicator, not a page-by-page
 * ticker. Once a stage lands on a terminal outcome (completed/failed/etc)
 * the message is shown even in compact mode, since that's the one place the
 * actual result ("Extraction complete — 12 page(s) ready.") or failure
 * reason is ever surfaced. The plain (non-compact) mode — used by the
 * synchronous cards/JSON import, which has no Details panel of its own —
 * always keeps the message line.
 */
export function renderImportProgress(p: ImportProgress, opts?: { compact?: boolean }): string {
  const compact = (opts?.compact ?? false) && (p.status === 'running' || p.status === 'pending');
  const barClass = p.status === 'failed' ? 'err' : p.status === 'completed_with_errors' ? 'warn' : p.status === 'completed' ? 'ok' : '';
  const staleUnits = p.staleUnits ?? 0;
  // Never fold failed/stale work into a clean-looking percentage — always
  // surface it as a standalone warning above the bar, regardless of status.
  const warning =
    p.failedUnits > 0 || staleUnits > 0
      ? `<div class="auth-err">⚠ ${[p.failedUnits > 0 ? `${p.failedUnits} page(s) failed` : '', staleUnits > 0 ? `${staleUnits} page(s) stuck` : ''].filter(Boolean).join(' · ')}${compact ? ' — see Details below.' : ' — see Admin details below.'}</div>`
      : '';
  const noProgressWarning =
    p.noProgressMinutes != null ? `<div class="auth-err">⚠ No progress for ${p.noProgressMinutes} minute(s).</div>` : '';
  return `
    <div class="import-progress">
      ${warning}
      ${noProgressWarning}
      <div class="import-progress-head">
        <span class="import-progress-stage">${esc(p.currentStage)}</span>
        <span class="import-progress-pct">${p.indeterminate ? '' : `${p.percent}%`}</span>
      </div>
      <div class="import-progress-bar ${p.indeterminate ? 'indeterminate' : ''} ${barClass}">
        <div class="import-progress-fill" style="width:${p.indeterminate ? 40 : p.percent}%"></div>
      </div>
      ${compact ? '' : `<p class="p-text" style="margin-top:8px">${esc(p.message)}</p>`}
      ${
        !compact && p.totalUnits != null
          ? `<p style="font-size:12px;color:var(--ink-faint);margin-top:2px">${p.completedUnits + p.failedUnits} / ${p.totalUnits} done${p.failedUnits ? ` · ${p.failedUnits} failed` : ''}</p>`
          : ''
      }
      ${
        p.errorDetail
          ? `<details class="import-error-details"><summary>Technical details</summary><pre>${esc(p.errorDetail)}</pre></details>`
          : ''
      }
    </div>`;
}
