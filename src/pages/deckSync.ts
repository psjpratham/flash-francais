import { findActiveSyncJob, getDeck, listDeckSyncs, queueDeckSync } from '../lib/decks';
import type { Deck, DeckSync, Job } from '../types';
import { errMsg, esc, toast } from '../lib/dom';
import { pollJob } from '../lib/jobPolling';
import type { ImportProgress } from '../lib/importProgress';
import { renderImportProgress } from './importProgressView';

export interface DeckSyncDeps {
  onBack: () => void;
}

/** Its own page rather than a button buried in an overflow menu — syncing is a real, slightly unusual action (add-only, can leave extra stacks around) that deserves a clear explanation up front, not just a click. */
export async function renderDeckSync(container: HTMLElement, deckId: string, deps: DeckSyncDeps): Promise<void> {
  let deck: Deck | null = null;
  let deckSyncs: DeckSync[] = [];
  let activeSyncJob: { label: string } | null = null;
  let stopSyncPoll: (() => void) | null = null;

  async function load(): Promise<void> {
    try {
      deck = await getDeck(deckId);
    } catch (e) {
      toast('Could not load deck: ' + errMsg(e));
      deps.onBack();
      return;
    }
    render();
    if (!deck.cloned_from_deck_id) return;
    try {
      deckSyncs = await listDeckSyncs(deckId);
    } catch (e) {
      toast('Could not load sync history: ' + errMsg(e));
    }
    try {
      const active = await findActiveSyncJob(deckId);
      if (active) {
        activeSyncJob = { label: 'Syncing with original deck…' };
        stopSyncPoll = pollJob(active.id, (job) => onSyncJobUpdate(job));
      }
    } catch {
      // best-effort — the job itself keeps running server-side regardless
    }
    render();
  }

  function render(): void {
    if (!deck) return;
    const notAClone = !deck.cloned_from_deck_id;
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← ${esc(deck.name)}</button>
        <div class="page-h">
          <h1>🔄 Resync & History </h1>
          <p>Pull in whatever's new on the deck this one was copied from.</p>
        </div>

        ${
          notAClone
            ? `<div class="panelbox"><p class="p-text">This deck isn't a clone of anything, so there's nothing to sync.</p></div>`
            : `
        <div class="composer-info">
          <strong>What syncing does</strong>
          <p>Pulls in anything new on the deck this was copied from — new cards in stacks you already have, brand new stacks, even entire new documents.</p>
          <strong>What it never does</strong>
          <ul>
            <li><strong>Never deletes or changes</strong> anything already in your deck — your own edits, progress, and scheduling are completely untouched.</li>
            <li><strong>Never touches the original</strong> — sync only ever reads from it, never writes back to it.</li>
          </ul>
          <strong>One thing to know</strong>
          <p>Because sync only ever adds, it can leave you with more stacks than before — for example, if the original was re-extracted since your last sync, you might end up with two versions of the same page. Nothing is merged or cleaned up automatically; that's still yours to manage from Manage content.</p>
        </div>

        <div id="syncActionSection" style="margin-top:18px"></div>
        <div id="syncHistorySection" style="margin-top:18px"></div>
        `
        }
      </div>`;

    document.getElementById('backBtn')?.addEventListener('click', deps.onBack);
    if (!notAClone) {
      renderSyncAction();
      renderSyncHistory();
    }
  }

  function renderSyncAction(): void {
    const el = document.getElementById('syncActionSection');
    if (!el) return;
    if (activeSyncJob) {
      const loaderProgress: ImportProgress = {
        status: 'running',
        currentStage: activeSyncJob.label,
        totalUnits: null,
        completedUnits: 0,
        failedUnits: 0,
        percent: 0,
        indeterminate: true,
        message: '',
      };
      el.innerHTML = `<div class="panelbox active-job-banner">${renderImportProgress(loaderProgress, { compact: true })}</div>`;
      return;
    }
    el.innerHTML = `<button class="btn-primary" id="syncDeckBtn">🔄 Sync with original deck now</button>`;
    document.getElementById('syncDeckBtn')?.addEventListener('click', () => void doSyncDeck());
  }

  function renderSyncHistory(): void {
    const el = document.getElementById('syncHistorySection');
    if (!el) return;
    el.innerHTML = `
      <div class="panelbox">
        <h3>Sync history</h3>
        ${
          deckSyncs.length
            ? `<ul class="sync-history-list">${deckSyncs.map(syncHistoryRowHTML).join('')}</ul>`
            : `<p class="p-text">No syncs yet.</p>`
        }
      </div>`;
  }

  function syncHistoryRowHTML(s: DeckSync): string {
    const when = esc(new Date(s.synced_at).toLocaleString());
    const detail =
      s.status === 'failed' ? `<span class="page-status-badge failed">failed</span> ${esc(s.error ?? '')}` : `${s.imports_added} import(s), ${s.stacks_added} stack(s), ${s.cards_added} card(s) added`;
    return `<li>${when} — ${detail}</li>`;
  }

  async function doSyncDeck(): Promise<void> {
    if (!deck || activeSyncJob) return;
    activeSyncJob = { label: 'Syncing with original deck…' };
    renderSyncAction();
    try {
      const jobId = await queueDeckSync(deck.id);
      stopSyncPoll = pollJob(jobId, (job) => onSyncJobUpdate(job));
    } catch (e) {
      activeSyncJob = null;
      toast('Could not queue sync: ' + errMsg(e));
      renderSyncAction();
    }
  }

  function onSyncJobUpdate(job: Job): void {
    if (job.status === 'completed') {
      stopSyncPoll?.();
      stopSyncPoll = null;
      activeSyncJob = null;
      const result = job.result as { stacks_added?: number; cards_added?: number; imports_added?: number } | null;
      const stacks = result?.stacks_added ?? 0;
      const cards = result?.cards_added ?? 0;
      const imports = result?.imports_added ?? 0;
      toast(stacks || cards || imports ? `Synced: ${imports} new import(s), ${stacks} new stack(s), ${cards} new card(s).` : 'Already up to date — nothing new to sync.');
      void refreshAfterSync();
    } else if (job.status === 'failed') {
      stopSyncPoll?.();
      stopSyncPoll = null;
      activeSyncJob = null;
      toast(syncFailureMessage(job.error));
      renderSyncAction();
    }
  }

  function syncFailureMessage(error: string | null): string {
    if (error === 'original_deck_deleted') return 'The original deck no longer exists — syncing is no longer possible.';
    if (error === 'not_a_clone') return "This deck isn't a clone of anything, so it can't be synced.";
    return 'Sync failed: ' + (error ?? 'unknown error');
  }

  async function refreshAfterSync(): Promise<void> {
    try {
      deckSyncs = await listDeckSyncs(deckId);
    } catch (e) {
      toast('Sync finished, but could not refresh history: ' + errMsg(e));
    }
    renderSyncAction();
    renderSyncHistory();
  }

  await load();
}
