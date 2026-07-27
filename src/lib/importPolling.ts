import { computeTextbookImportProgress, type TextbookImportProgress } from './importProgress';
import { isTerminal } from './importProgress';

const DEFAULT_INTERVAL_MS = 4000;

/**
 * Polls persisted import progress on an interval — a pure observer, never a
 * driver of work (see importProgress.ts). Used by both the import detail
 * page and the deck's "Document imports" list. Stops itself once the import
 * reaches a terminal state, but the caller can always stop early via the
 * returned function (e.g. on navigating away).
 */
export function startImportPolling(
  importId: string,
  onUpdate: (progress: TextbookImportProgress) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const progress = await computeTextbookImportProgress(importId);
      if (stopped) return;
      onUpdate(progress);
      if (isTerminal(progress.status)) return; // nothing left to observe
    } catch {
      // A transient read failure shouldn't kill polling — just try again next tick.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
