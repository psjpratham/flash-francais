import { deleteDeckDeep, fetchDeckStats, getDeckWithCounts, renameDeck, setDeckPublic, shortDeckId } from '../lib/decks';
import type { DeckStatsWithStreak, DeckWithCounts } from '../types';
import { $, errMsg, esc, promptDialog, toast } from '../lib/dom';
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
  /** Opens the "Sync with original deck" page (explanation + action + history) — only ever shown for a deck that's actually a clone. */
  onOpenDeckSync: (deckId: string) => void;
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
  let togglingPublic = false;

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
        <div class="page-h">
          <h1>${esc(deck.name)} ${deck.is_public ? '<span class="pill" title="Anyone can find and view this deck">🌍 Public</span>' : ''}</h1>
          <p>${deck._due} due · ${deck._new} new · <span class="deck-id-badge" title="Deck ID — used to find this deck by search">#${esc(shortDeckId(deck.id))}</span></p>
        </div>

        <div class="hero-row">
          <button class="hero-cta hero-cta-practice" id="startSessionBtn">
            <span class="hero-cta-main">▶ Practice Mode</span>
            <span class="hero-cta-sub">${deck._due + deck._new} cards ready</span>
            <span class="hero-cta-sub hero-cta-sub-detail">Test yourself and track your progress.</span>
          </button>
          <button class="hero-cta hero-cta-study" id="openStudyPickerBtn">
            <span class="hero-cta-main">📖 Study Mode</span>
            <span class="hero-cta-sub hero-cta-sub-detail">Flip through your cards at your own pace to revise or study.</span>
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
                            <button class="btn-sec" id="renameDeckBtn">✎ Rename deck</button>
                            <button class="btn-sec" id="togglePublicBtn" ${togglingPublic ? 'disabled' : ''}>${deck.is_public ? '🔒 Make private' : '🌍 Make public'}</button>
                            <button class="btn-sec" id="importContentBtn">📥 Import content</button>
                            ${deck.cloned_from_deck_id ? `<button class="btn-sec" id="deckSyncBtn">🔄 Resync & History</button>` : ''}
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
    document.getElementById('renameDeckBtn')?.addEventListener('click', () => {
      showOverflowMenu = false;
      render();
      void doRenameDeck();
    });
    document.getElementById('togglePublicBtn')?.addEventListener('click', () => {
      showOverflowMenu = false;
      void doTogglePublic();
    });
    document.getElementById('importContentBtn')?.addEventListener('click', () => deps.onImportContent(deck!.id, deck!.name));
    document.getElementById('deckSyncBtn')?.addEventListener('click', () => deps.onOpenDeckSync(deck!.id));
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

  // ---------- rename deck ----------

  async function doRenameDeck(): Promise<void> {
    if (!deck) return;
    const name = await promptDialog('Rename deck', deck.name);
    if (!name || name === deck.name) return;
    try {
      const updated = await renameDeck(deck.id, name);
      deck.name = updated.name;
      render();
      toast('Deck renamed.');
    } catch (e) {
      toast('Could not rename: ' + errMsg(e));
    }
  }

  // ---------- public toggle ----------

  async function doTogglePublic(): Promise<void> {
    if (!deck || togglingPublic) return;
    const nextPublic = !deck.is_public;
    togglingPublic = true;
    render();
    try {
      const updated = await setDeckPublic(deck.id, nextPublic);
      deck.is_public = updated.is_public;
      toast(nextPublic ? 'Deck is now public — anyone can find it by title, author, or ID.' : 'Deck is private again.');
    } catch (e) {
      toast('Could not update visibility: ' + errMsg(e));
    } finally {
      togglingPublic = false;
      render();
    }
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
        <h3>📊 This deck's stats <span class="stats-scope-note">— just this deck, not the others</span></h3>
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
