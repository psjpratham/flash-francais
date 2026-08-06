import { supabase } from './supabase';
import type { Job, JobStatus } from '../types';

const DEFAULT_INTERVAL_MS = 2500;

function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Polls a single job row by id — the card/page-level equivalent of
 * importPolling.ts's startImportPolling, for jobs with no import-wide
 * aggregate progress to compute (e.g. generate_cards, extract_page fired
 * from the manage page). Stops itself once the job reaches a terminal
 * state; the caller can always stop early via the returned function.
 */
export function pollJob(jobId: string, onUpdate: (job: Job) => void, intervalMs = DEFAULT_INTERVAL_MS): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).single();
      if (stopped) return;
      if (!error && data) {
        onUpdate(data as Job);
        if (isTerminal((data as Job).status)) return; // nothing left to observe
      }
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
