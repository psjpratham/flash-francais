import { deleteImportCompletely, listImportsForDeck } from '../lib/imports';
import { computeTextbookImportProgress, type TextbookImportProgress } from '../lib/importProgress';
import { listStackTilesForDeck, type StackTile } from '../lib/stacks';
import type { Import } from '../types';
import { $, confirmDialog, errMsg, esc, toast } from '../lib/dom';

export interface StacksListDeps {
  onBack: () => void;
  deckId: string;
  deckName: string;
  /** Opens Manage/Edit/Review scoped directly to this import, starting at the given page. */
  onOpenPageStack: (importId: string, pageId: string) => void;
  /** Opens the durable import-detail route for one specific import — the admin drill-down behind this page's in-progress banner. */
  onOpenImportDetail: (deckId: string, deckName: string, importId: string) => void;
}

interface ImportProgressRow {
  imp: Import;
  progress: TextbookImportProgress;
}

/** Worth flagging on a tile — everything else ('needs_review', 'approved') is just internal bookkeeping the learner never needs to act on. */
function attentionBadge(tile: StackTile): string {
  if (tile.status === 'failed') return `<span class="page-status-badge failed">${tile.failedCount > 1 ? `${tile.failedCount} pages failed` : 'extraction failed'}</span>`;
  if (tile.status === 'processing' || tile.status === 'pending') return `<span class="page-status-badge processing">extracting…</span>`;
  return '';
}

/**
 * Manage-content: one tile per import, full stop — however many pages a
 * pdf/doc import split into internally (each still its own extraction
 * attempt, tracked independently — see extractWorker.ts) is purely backend
 * bookkeeping; browsing page by page already happens one level in, inside
 * page review itself (Prev/Next stack). This page never shows that split.
 * The one other kind of tile here is the standalone "Manual cards" bucket,
 * which has no import behind it at all (see StackTile.isImport).
 */
export async function renderStacksList(container: HTMLElement, deps: StacksListDeps): Promise<void> {
  let tiles: StackTile[] | null = null;
  let loadError: string | null = null;
  let busyDeleteId: string | null = null;

  /** Imports whose content is fully extracted have nothing left to monitor — this banner only ever tracks imports still actually moving (or stuck on a failure worth retrying). */
  function isDoneProcessing(status: Import['status']): boolean {
    return status === 'needs_review' || status === 'completed';
  }
  let inProgressImports: ImportProgressRow[] | null = null;

  async function loadInProgressImports(): Promise<void> {
    try {
      const imports = await listImportsForDeck(deps.deckId);
      const active = imports.filter((imp) => !isDoneProcessing(imp.status));
      inProgressImports = await Promise.all(active.map(async (imp) => ({ imp, progress: await computeTextbookImportProgress(imp.id) })));
    } catch {
      inProgressImports = [];
    }
    renderImportBanner();
  }

  function render(): void {
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← ${esc(deps.deckName)}</button>
        <div class="page-h-row">
          <div class="page-h"><h1>📦 Manage content</h1><p>Every stack of cards in this deck, grouped by where it came from.</p></div>
        </div>
        <div id="importBanner"></div>
        <div id="stacksBody">${renderBody()}</div>
      </div>`;
    $(container, '#backBtn').addEventListener('click', deps.onBack);
    renderImportBanner();
    wireBody();
  }

  function renderImportBanner(): void {
    const el = document.getElementById('importBanner');
    if (!el) return;
    if (!inProgressImports?.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = inProgressImports
      .map(
        ({ imp, progress }) => `
      <div class="import-banner">
        <span>📚 <strong>${esc(imp.title)}</strong> — ${esc(progress.currentStage)}, ${progress.percent}%</span>
        <button class="btn-sec" data-view-import="${esc(imp.id)}">View details</button>
      </div>`,
      )
      .join('');
    el.querySelectorAll<HTMLButtonElement>('[data-view-import]').forEach((btn) => {
      btn.addEventListener('click', () => deps.onOpenImportDetail(deps.deckId, deps.deckName, btn.dataset.viewImport!));
    });
  }

  function renderBody(): string {
    if (loadError) return `<div class="panelbox">Could not load stacks: ${esc(loadError)}</div>`;
    if (!tiles) return `<div class="stats-loading">Loading stacks…</div>`;
    if (!tiles.length) return `<div class="panelbox"><p class="p-text">No stacks yet — import a source document or add some cards to get started.</p></div>`;
    return `<div class="panelbox"><div class="stack-grid">${tiles.map(tileHTML).join('')}</div></div>`;
  }

  function tileHTML(tile: StackTile): string {
    const allIncluded = tile.cardCount > 0 && tile.includedCount >= tile.cardCount;
    const noneIncluded = tile.cardCount > 0 && tile.includedCount === 0;
    const canManage = !!tile.representativeSourcePageId;
    const deleting = busyDeleteId === tile.id;
    return `
      <div class="stack-card" data-tile-id="${esc(tile.id)}">
        <div class="stack-card-top">
          <span class="stack-card-icon">${tile.isImport ? '📚' : '🗂️'}</span>
          ${attentionBadge(tile)}
        </div>
        <div class="stack-card-title">${esc(tile.name)}</div>
        <div class="stack-card-meta">
          <span>${tile.cardCount} card${tile.cardCount === 1 ? '' : 's'}</span>
          <span class="${allIncluded ? 'stack-card-all-in' : noneIncluded ? 'stack-card-none-in' : ''}">${tile.includedCount}/${tile.cardCount} queued in Practice Mode</span>
        </div>
        <div class="stack-card-actions">
          <button class="btn-sec" data-manage="${esc(tile.id)}" ${canManage ? '' : 'disabled title="Coming soon"'}>✎ Manage</button>
          ${tile.isImport ? `<button class="btn-sec" data-delete-import="${esc(tile.id)}" ${deleting ? 'disabled' : ''} title="Delete this import and every card it produced">${deleting ? '…' : '🗑 Delete'}</button>` : ''}
        </div>
      </div>`;
  }

  function wireBody(): void {
    container.querySelectorAll<HTMLButtonElement>('[data-manage]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tile = tiles?.find((t) => t.id === btn.dataset.manage);
        if (!tile) return;
        if (!tile.representativeSourcePageId) {
          toast('Managing this stack directly is coming soon.');
          return;
        }
        deps.onOpenPageStack(tile.id, tile.representativeSourcePageId);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('[data-delete-import]').forEach((btn) => {
      btn.addEventListener('click', () => void doDeleteImport(btn.dataset.deleteImport!));
    });
  }

  async function doDeleteImport(importId: string): Promise<void> {
    if (busyDeleteId) return;
    const tile = tiles?.find((t) => t.id === importId);
    if (!tile) return;
    if (!(await confirmDialog(`Delete "${tile.name}"? This permanently removes it and all ${tile.cardCount} card${tile.cardCount === 1 ? '' : 's'} it produced — this cannot be undone.`))) return;
    busyDeleteId = importId;
    const body = document.getElementById('stacksBody');
    if (body) body.innerHTML = renderBody();
    wireBody();
    try {
      await deleteImportCompletely(importId);
      toast('Import deleted.');
      await load();
    } catch (e) {
      toast('Could not delete: ' + errMsg(e));
    } finally {
      busyDeleteId = null;
      const el = document.getElementById('stacksBody');
      if (el) {
        el.innerHTML = renderBody();
        wireBody();
      }
    }
  }

  async function load(): Promise<void> {
    try {
      tiles = await listStackTilesForDeck(deps.deckId);
    } catch (e) {
      loadError = errMsg(e);
    }
    const body = document.getElementById('stacksBody');
    if (body) {
      body.innerHTML = renderBody();
      wireBody();
    }
  }

  render();
  await Promise.all([load(), loadInProgressImports()]);
}
