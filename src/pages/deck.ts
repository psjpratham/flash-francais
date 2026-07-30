import { deleteDeckDeep, fetchDeckStats, getDeckWithCounts } from '../lib/decks';
import type { DeckStatsWithStreak, DeckWithCounts } from '../types';
import { $, errMsg, esc, toast } from '../lib/dom';
import { accuracyPct, statsMoreHTML } from './statsPanel';

export interface DeckDetailDeps {
  onBack: () => void;
  /** Practice is deliberately unfilterable — whatever's due, deck-wide. Picking what to look at is Study mode's job (onOpenStudyPicker), a separate front door. */
  onStartSession: (deck: DeckWithCounts) => void;
  /** Opens the Study picker — choose which stack(s), optionally narrowed by tag, to walk through with no scheduling. */
  onOpenStudyPicker: (deckId: string, deckName: string) => void;
  /** Current signed-in user's id — only the deck's owner sees/can use Delete deck or Import content. */
  currentUserId: string;
  /** Fired after the deck is successfully deleted; caller should return to the (refreshed) library. */
  onDeleted: () => void;
  /** Opens the unified, deck-scoped import flow (textbook or cards/JSON) — always this deck, never creates another. */
  onImportContent: (deckId: string, deckName: string) => void;
  /** Opens the Manage-content browser for this deck (grouped stacks, status, edit — no study/selection here). */
  onOpenStacks: (deckId: string, deckName: string) => void;
}

export async function renderDeckDetail(container: HTMLElement, deckId: string, deps: DeckDetailDeps): Promise<void> {
  let deck: DeckWithCounts | null = null;
  let statsData: DeckStatsWithStreak | null = null;
  let showMoreStats = false;
  let showDeleteConfirm = false;
  let deleteConfirmText = '';
  let deleting = false;
  let deleteError: string | null = null;
  let showOverflowMenu = false;

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
  }

  function render(): void {
    if (!deck) return;
    const isOwner = deck.user_id === deps.currentUserId;
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← Decks</button>
        <div class="page-h"><h1>${esc(deck.name)}</h1><p>${deck._due} due · ${deck._new} new</p></div>

        <div class="hero-row">
          <button class="hero-cta hero-cta-practice" id="startSessionBtn">
            <span class="hero-cta-main">▶ Practice Mode</span>
            <span class="hero-cta-sub">${deck._due + deck._new} cards ready</span>
          </button>
          <button class="hero-cta hero-cta-study" id="openStudyPickerBtn">
            <span class="hero-cta-main">📖 Study Mode</span>
            <span class="hero-cta-sub">Read through any stack, no scheduling</span>
          </button>
        </div>

        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn-sec" id="openStacksBtn">📦 Manage content</button>
          ${
            isOwner
              ? `<div class="toolbar-more">
                   <button class="btn-sec" id="deckMoreBtn">⋯</button>
                   ${
                     showOverflowMenu
                       ? `<div class="toolbar-more-menu">
                            <button class="btn-sec" id="importContentBtn">📥 Import content</button>
                            <button class="btn-sec" id="deleteDeckBtn">🗑 Delete deck</button>
                          </div>`
                       : ''
                   }
                 </div>`
              : ''
          }
        </div>

        <div id="deleteDeckSection" style="margin-top:18px"></div>

        <div id="deckStats" style="margin-top:18px"><div class="stats-loading">Crunching numbers…</div></div>
      </div>`;

    $(container, '#backBtn').addEventListener('click', deps.onBack);
    $(container, '#startSessionBtn').addEventListener('click', () => deps.onStartSession(deck!));
    $(container, '#openStudyPickerBtn').addEventListener('click', () => deps.onOpenStudyPicker(deck!.id, deck!.name));
    document.getElementById('openStacksBtn')?.addEventListener('click', () => deps.onOpenStacks(deck!.id, deck!.name));
    document.getElementById('deckMoreBtn')?.addEventListener('click', () => {
      showOverflowMenu = !showOverflowMenu;
      render();
    });
    document.getElementById('importContentBtn')?.addEventListener('click', () => deps.onImportContent(deck!.id, deck!.name));
    document.getElementById('deleteDeckBtn')?.addEventListener('click', () => {
      showOverflowMenu = false;
      showDeleteConfirm = true;
      deleteConfirmText = '';
      deleteError = null;
      render();
    });

    renderStatsSection();
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

  // ---------- stats ----------

  function statsHTML(data: DeckStatsWithStreak): string {
    return `
      <div class="panelbox">
        <h3>📊 This deck's stats</h3>
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
