import { deleteDeckDeep, fetchDeckStats, fetchDeckTags, getDeckWithCounts } from '../lib/decks';
import { listImportsForDeck } from '../lib/imports';
import { computeTextbookImportProgress, type TextbookImportProgress } from '../lib/importProgress';
import type { DeckStatsWithStreak, DeckTagCount, DeckWithCounts, Import } from '../types';
import { $, errMsg, esc, toast } from '../lib/dom';
import { accuracyPct, statsMoreHTML } from './statsPanel';

export interface DeckDetailDeps {
  onBack: () => void;
  onStartSession: (deck: DeckWithCounts, tagFilter: string[]) => void;
  /** Opens the durable import-detail route for one specific import — never "the latest", always a real import_id. */
  onOpenImport: (deckId: string, deckName: string, importId: string) => void;
  /** Current signed-in user's id — only the deck's owner sees/can use Delete deck or Import content. */
  currentUserId: string;
  /** Fired after the deck is successfully deleted; caller should return to the (refreshed) library. */
  onDeleted: () => void;
  /** Opens the unified, deck-scoped import flow (textbook or cards/JSON) — always this deck, never creates another. */
  onImportContent: (deckId: string, deckName: string) => void;
}

interface ImportRow {
  imp: Import;
  progress: TextbookImportProgress;
}

export async function renderDeckDetail(container: HTMLElement, deckId: string, deps: DeckDetailDeps): Promise<void> {
  let deck: DeckWithCounts | null = null;
  let showTagFilter = false;
  let tagFilter: string[] = [];
  let deckTags: DeckTagCount[] | null = null;
  let statsData: DeckStatsWithStreak | null = null;
  let showMoreStats = false;
  let showDeleteConfirm = false;
  let deleteConfirmText = '';
  let deleting = false;
  let deleteError: string | null = null;
  let importRows: ImportRow[] | null = null;

  async function load(): Promise<void> {
    try {
      deck = await getDeckWithCounts(deckId);
    } catch (e) {
      toast('Could not load deck: ' + errMsg(e));
      deps.onBack();
      return;
    }
    render();
    await loadStats();
    if (deck.user_id === deps.currentUserId) await loadImports();
  }

  async function loadImports(): Promise<void> {
    try {
      const imports = await listImportsForDeck(deckId);
      importRows = await Promise.all(
        imports.map(async (imp) => ({ imp, progress: await computeTextbookImportProgress(imp.id) })),
      );
    } catch (e) {
      toast('Could not load imports: ' + errMsg(e));
      importRows = [];
    }
    renderImportsSection();
  }

  function render(): void {
    if (!deck) return;
    const filterActive = tagFilter.length > 0;
    const isOwner = deck.user_id === deps.currentUserId;
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← Decks</button>
        <div class="page-h"><h1>${esc(deck.name)}</h1><p>${deck._due} due · ${deck._new} new</p></div>

        <button class="hero-cta" id="startSessionBtn">
          <span class="hero-cta-main">▶ Start session</span>
          <span class="hero-cta-sub">${
            filterActive ? 'Filtered: ' + esc(tagFilter.join(', ')) : `${deck._due + deck._new} cards ready`
          }</span>
        </button>

        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn-sec" id="toggleTagFilterBtn">🏷️ ${filterActive ? `Filter (${tagFilter.length})` : 'Filter by tag'}</button>
          ${isOwner ? `<button class="btn-sec" id="importContentBtn">📥 Import content</button>` : ''}
          ${isOwner ? `<button class="btn-danger" id="deleteDeckBtn">🗑 Delete deck</button>` : ''}
        </div>

        <div id="deleteDeckSection" style="margin-top:18px"></div>

        <div id="tagFilterSection" class="${showTagFilter ? '' : 'hide'}" style="margin-top:18px"></div>

        ${isOwner ? '<div id="importsSection" style="margin-top:18px"></div>' : ''}

        <div id="deckStats" style="margin-top:18px"><div class="stats-loading">Crunching numbers…</div></div>
      </div>`;

    $(container, '#backBtn').addEventListener('click', deps.onBack);
    $(container, '#startSessionBtn').addEventListener('click', () => deps.onStartSession(deck!, tagFilter));
    $(container, '#toggleTagFilterBtn').addEventListener('click', () => {
      showTagFilter = !showTagFilter;
      render();
    });
    document.getElementById('importContentBtn')?.addEventListener('click', () => deps.onImportContent(deck!.id, deck!.name));
    document.getElementById('deleteDeckBtn')?.addEventListener('click', () => {
      showDeleteConfirm = true;
      deleteConfirmText = '';
      deleteError = null;
      render();
    });

    if (showTagFilter) void renderTagFilterSection();
    renderStatsSection();
    if (isOwner) renderImportsSection();
    renderDeleteDeckSection();
  }

  // ---------- delete deck ----------

  function renderDeleteDeckSection(): void {
    const el = document.getElementById('deleteDeckSection');
    if (!el || !deck) return;
    if (!showDeleteConfirm) {
      el.innerHTML = '';
      return;
    }
    const confirmed = deleteConfirmText.trim() === deck.name;
    el.innerHTML = `
      <div class="panelbox">
        <h3>Delete "${esc(deck.name)}"?</h3>
        ${deleteError ? `<div class="auth-err">${esc(deleteError)}</div>` : ''}
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
          This permanently deletes the deck <strong>${esc(deck.name)}</strong> and everything under it:
          its cards, imports, extracted pages, and any uploaded source/audio files. This cannot be undone.
        </p>
        <div class="field">
          <label>Type the deck name to confirm</label>
          <input id="deleteConfirmInput" placeholder="${esc(deck.name)}" value="${esc(deleteConfirmText)}" ${deleting ? 'disabled' : ''}>
        </div>
        <div class="row">
          <button class="btn-danger" id="confirmDeleteBtn" ${confirmed && !deleting ? '' : 'disabled'}>${deleting ? 'Deleting…' : 'Delete permanently'}</button>
          <button class="btn-sec" id="cancelDeleteBtn" ${deleting ? 'disabled' : ''}>Cancel</button>
        </div>
      </div>`;

    const input = $<HTMLInputElement>(el, '#deleteConfirmInput');
    const confirmBtn = $<HTMLButtonElement>(el, '#confirmDeleteBtn');
    input.addEventListener('input', () => {
      deleteConfirmText = input.value;
      confirmBtn.disabled = deleteConfirmText.trim() !== deck!.name;
    });
    $(el, '#cancelDeleteBtn').addEventListener('click', () => {
      showDeleteConfirm = false;
      render();
    });
    $(el, '#confirmDeleteBtn').addEventListener('click', () => void doDelete());
  }

  async function doDelete(): Promise<void> {
    if (!deck || deleteConfirmText.trim() !== deck.name) return;
    deleting = true;
    deleteError = null;
    renderDeleteDeckSection();
    try {
      await deleteDeckDeep(deck.id);
      toast('Deck deleted');
      deps.onDeleted();
    } catch (e) {
      deleteError = 'Could not delete deck: ' + errMsg(e);
      deleting = false;
      renderDeleteDeckSection();
    }
  }

  // ---------- document imports ----------

  function fmtTime(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  function importRowHTML({ imp, progress }: ImportRow): string {
    const totalPages = imp.total_pages;
    const extractedOf = progress.totalUnits != null ? `${progress.completedUnits} / ${progress.totalUnits}` : '—';
    return `
      <div class="import-list-row">
        <div class="import-list-row-h">
          <span class="import-list-title">${esc(imp.title)}</span>
          <span class="page-status-badge ${esc(imp.status)}">${esc(imp.status.replace(/_/g, ' '))}</span>
        </div>
        <div class="import-list-meta">
          <span>Created ${fmtTime(imp.created_at)}</span>
          <span>${progress.percent}%</span>
          <span>${imp.pages_prepared} / ${totalPages ?? '?'} pages prepared</span>
          <span>${extractedOf} extracted</span>
          ${progress.failedUnits > 0 ? `<span class="import-list-warn">${progress.failedUnits} failed</span>` : ''}
          ${progress.reviewCounts?.needsReview ? `<span>${progress.reviewCounts.needsReview} need review</span>` : ''}
          <span>Updated ${fmtTime(imp.updated_at)}</span>
        </div>
        <button class="btn-sec" data-open-import="${esc(imp.id)}">Open import</button>
      </div>`;
  }

  function renderImportsSection(): void {
    const el = document.getElementById('importsSection');
    if (!el || !deck) return;
    if (importRows === null) {
      el.innerHTML = `<div class="panelbox"><p class="p-text">Loading imports…</p></div>`;
      return;
    }
    if (!importRows.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `
      <div class="panelbox">
        <h3>Document imports</h3>
        <div class="import-list">${importRows.map(importRowHTML).join('')}</div>
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-open-import]').forEach((btn) => {
      btn.addEventListener('click', () => deps.onOpenImport(deck!.id, deck!.name, btn.dataset.openImport!));
    });
  }

  // ---------- tag filter ----------

  async function renderTagFilterSection(): Promise<void> {
    if (!deck) return;
    let el = document.getElementById('tagFilterSection');
    if (!el) return;
    if (!deckTags) {
      el.innerHTML = `<div class="stats-loading">Loading tags…</div>`;
      try {
        deckTags = await fetchDeckTags(deck.id);
      } catch (e) {
        el = document.getElementById('tagFilterSection'); // may have been re-rendered while awaiting
        if (el) el.innerHTML = `<div class="panelbox">Couldn't load tags: ${esc(errMsg(e))}</div>`;
        return;
      }
    }
    el = document.getElementById('tagFilterSection');
    if (!el) return;
    if (!deckTags.length) {
      el.innerHTML = `<div class="panelbox"><p style="font-size:13px;color:var(--ink-faint)">No tags on this deck's cards yet.</p></div>`;
      return;
    }
    el.innerHTML = `
      <div class="panelbox">
        <h3>Filter by tag <span style="font-weight:400;color:var(--ink-faint);font-size:12.5px">(matches any tag selected)</span></h3>
        <div class="tagbar">
          ${deckTags
            .map(
              (t) =>
                `<button class="${tagFilter.includes(t.tag) ? 'on' : ''}" data-tag="${esc(t.tag)}">${esc(t.tag)} <span style="opacity:.6">${t.count}</span></button>`,
            )
            .join('')}
        </div>
        ${tagFilter.length ? `<button class="btn-sec" id="clearTagFilterBtn">Clear filter (${tagFilter.length})</button>` : ''}
      </div>
    `;
    el.querySelectorAll<HTMLElement>('.tagbar button[data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => toggleTagFilter(btn.dataset.tag!));
    });
    document.getElementById('clearTagFilterBtn')?.addEventListener('click', () => {
      tagFilter = [];
      render();
    });
  }

  function toggleTagFilter(tag: string): void {
    const i = tagFilter.indexOf(tag);
    if (i >= 0) tagFilter.splice(i, 1);
    else tagFilter.push(tag);
    render();
  }

  // ---------- stats ----------

  function statsHTML(data: DeckStatsWithStreak): string {
    return `
      <div class="panelbox">
        <h3>This deck's stats</h3>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-v">${data.reviews.today}</div><div class="stat-k">reviewed today</div></div>
          <div class="stat-item"><div class="stat-v">${accuracyPct(data.ratingsToday)}%</div><div class="stat-k">accuracy today</div></div>
          <div class="stat-item"><div class="stat-v">${data.due.now}</div><div class="stat-k">due now</div></div>
          <div class="stat-item"><div class="stat-v">${data.due.week}</div><div class="stat-k">due in 7 days</div></div>
        </div>
        <button class="more-toggle" id="moreStatsBtn">${showMoreStats ? '− Show less' : '+ More stats'}</button>
        <div id="statsMore">${showMoreStats ? statsMoreHTML(data) : ''}</div>
      </div>
    `;
  }

  function renderStatsSection(): void {
    const el = document.getElementById('deckStats');
    if (!el) return;
    el.innerHTML = statsData ? statsHTML(statsData) : '<div class="stats-loading">Crunching numbers…</div>';
    document.getElementById('moreStatsBtn')?.addEventListener('click', () => {
      showMoreStats = !showMoreStats;
      renderStatsSection();
    });
  }

  async function loadStats(): Promise<void> {
    if (!deck) return;
    try {
      statsData = await fetchDeckStats(deck.id);
    } catch {
      statsData = null;
    }
    renderStatsSection();
  }

  await load();
}
