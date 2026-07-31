import { listDecksWithCounts, createDeck, fetchDeckStats, searchPublicDecks, shortDeckId, addPublicDeckToMyDecks } from '../lib/decks';
import type { DeckStatsWithStreak, DeckWithCounts, PublicDeckSearchResult } from '../types';
import { $, esc, errMsg, openModal, toast } from '../lib/dom';
import { accuracyPct, statsMoreHTML } from './statsPanel';

export interface LibraryDeps {
  onOpenDeck: (deckId: string) => void;
  onStudyAll: () => void;
  /** Fired once total-due / streak are known, so the header chips can reflect them. */
  onStatsLoaded?: (totalDue: number, streakCurrent: number) => void;
}

export async function renderLibrary(container: HTMLElement, deps: LibraryDeps): Promise<void> {
  let decks: DeckWithCounts[] = [];
  let statsData: DeckStatsWithStreak | null = null;
  let showMoreStats = false;

  let searchQuery = '';
  let searchResults: PublicDeckSearchResult[] = [];
  let searching = false;
  let searchError: string | null = null;
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  let searchToken = 0;
  const addingDeckIds = new Set<string>();

  function totalDue(): number {
    return decks.reduce((a, d) => a + d._due + d._new, 0);
  }

  function render(): void {
    container.innerHTML = `
      <div class="wrap">
        <div class="page-h"><h1>Your decks</h1><p>Everything you're studying.</p></div>
        ${
          decks.length
            ? `<div class="due-banner">
                 <div><h2>${totalDue()} cards waiting</h2><p>Across all decks</p></div>
                 <button id="studyAllBtn">▶ Practice everything due</button>
               </div>`
            : ''
        }
        <div id="libStats">${statsData ? statsHTML(statsData) : '<div class="stats-loading">Crunching numbers…</div>'}</div>

        <div class="panelbox" id="publicSearchBox">
          <h3>🔎 Discover public decks</h3>
          <div class="field">
            <input id="publicSearchInput" placeholder="Search by title, author, or deck ID…" value="${esc(searchQuery)}">
          </div>
          <div id="publicSearchResults"></div>
        </div>

        <div class="grid" id="deckGrid"></div>
      </div>`;

    $(container, '#publicSearchInput').addEventListener('input', (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => void runSearch(), 300);
    });
    renderSearchResults();

    const grid = $(container, '#deckGrid');
    grid.innerHTML =
      decks
        .map(
          (d) => `
      <div class="course" data-id="${d.id}">
        <div class="course-top">
          <div class="course-badge">📘</div>
          <div><div class="course-title">${esc(d.name)}</div><div class="course-meta">${esc(d.source)}</div></div>
        </div>
        <div class="course-foot">
          ${d.visibility === 'shared' ? `<span class="pill">Shared</span>` : ''}
          ${d.status === 'draft' ? `<span class="pill">Draft</span>` : ''}
          ${d._due ? `<span class="pill due">${d._due} due</span>` : ''}
          ${d._new ? `<span class="pill new">${d._new} new</span>` : ''}
          ${!d._due && !d._new ? `<span class="pill">all caught up</span>` : ''}
        </div>
      </div>`,
        )
        .join('') + `<div class="course add-course" id="addDeckBtn"><span class="plus">+</span>New deck</div>`;

    grid.querySelectorAll<HTMLElement>('.course[data-id]').forEach((el) => {
      el.addEventListener('click', () => deps.onOpenDeck(el.dataset.id!));
    });
    $(grid, '#addDeckBtn').addEventListener('click', addDeck);
    if (decks.length) {
      $(container, '#studyAllBtn').addEventListener('click', deps.onStudyAll);
    }
    wireStats();
  }

  function addDeck(): void {
    const { box, close } = openModal(`
      <h3>Create a new deck</h3>
      <div class="field"><label>Deck name</label><input id="newDeckName" placeholder="e.g. Unit 4 — Sorties"></div>
      <div class="field">
        <label>Visibility</label>
        <div class="visibility-choice">
          <button type="button" class="visibility-option on" data-visibility="personal">
            <span class="vo-icon">🔒</span><span class="vo-label">Private</span><span class="vo-desc">Only you can see it</span>
          </button>
          <button type="button" class="visibility-option" data-visibility="shared" disabled>
            <span class="vo-icon">🌍</span><span class="vo-label">Public</span><span class="vo-desc">Searchable by anyone — coming soon</span>
          </button>
        </div>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn-sec" id="cancelCreateBtn">Cancel</button>
        <button class="btn-primary" id="confirmCreateBtn" style="width:auto">Create deck</button>
      </div>
    `);

    const nameInput = $<HTMLInputElement>(box, '#newDeckName');
    nameInput.focus();

    box.querySelectorAll<HTMLButtonElement>('.visibility-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) {
          toast('Public decks are coming soon');
          return;
        }
        box.querySelectorAll('.visibility-option').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
      });
    });

    async function submitCreate(): Promise<void> {
      const name = nameInput.value.trim();
      if (!name) {
        toast('Enter a deck name');
        return;
      }
      try {
        await createDeck(name);
        toast('Deck created');
        close();
        await loadDecks();
        render();
      } catch (e) {
        toast('Could not create deck: ' + errMsg(e));
      }
    }

    $(box, '#cancelCreateBtn').addEventListener('click', close);
    $(box, '#confirmCreateBtn').addEventListener('click', () => void submitCreate());
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submitCreate();
    });
  }

  async function runSearch(): Promise<void> {
    const query = searchQuery.trim();
    if (!query) {
      searching = false;
      searchError = null;
      searchResults = [];
      renderSearchResults();
      return;
    }
    const token = ++searchToken;
    searching = true;
    searchError = null;
    renderSearchResults();
    try {
      const results = await searchPublicDecks(query);
      if (token !== searchToken) return; // a newer keystroke's search already superseded this one
      searchResults = results;
    } catch (e) {
      if (token !== searchToken) return;
      searchError = errMsg(e);
      searchResults = [];
    } finally {
      if (token === searchToken) searching = false;
      renderSearchResults();
    }
  }

  function renderSearchResults(): void {
    const el = document.getElementById('publicSearchResults');
    if (!el) return; // navigated away
    if (!searchQuery.trim()) {
      el.innerHTML = '';
      return;
    }
    if (searching) {
      el.innerHTML = '<div class="stats-loading">Searching…</div>';
      return;
    }
    if (searchError) {
      el.innerHTML = `<p class="p-text">Could not search: ${esc(searchError)}</p>`;
      return;
    }
    if (!searchResults.length) {
      el.innerHTML = '<p class="p-text">No public decks match that search.</p>';
      return;
    }
    el.innerHTML = `<div class="grid">${searchResults
      .map((r) => {
        const adding = addingDeckIds.has(r.id);
        return `
      <div class="course public-deck-result" data-id="${r.id}">
        <div class="course-top">
          <div class="course-badge">🌍</div>
          <div><div class="course-title">${esc(r.name)}</div><div class="course-meta">by ${esc(r.author_display_name ?? 'Anonymous')}</div></div>
        </div>
        <div class="course-foot">
          <span class="pill">${r.card_count} card${r.card_count === 1 ? '' : 's'}</span>
          <span class="pill deck-id-pill" title="Deck ID">#${esc(shortDeckId(r.id))}</span>
          <button class="btn-sec add-public-deck-btn" data-id="${r.id}" ${adding ? 'disabled' : ''} style="margin-left:auto">
            ${adding ? 'Adding…' : '+ Add to my decks'}
          </button>
        </div>
      </div>`;
      })
      .join('')}</div>`;

    el.querySelectorAll<HTMLButtonElement>('.add-public-deck-btn').forEach((btn) => {
      btn.addEventListener('click', () => void addFromSearch(btn.dataset.id!));
    });
  }

  async function addFromSearch(deckId: string): Promise<void> {
    if (addingDeckIds.has(deckId)) return;
    addingDeckIds.add(deckId);
    renderSearchResults();
    try {
      const added = await addPublicDeckToMyDecks(deckId);
      toast(`"${added.name}" added to your decks`);
      await loadDecks();
      render();
    } catch (e) {
      toast('Could not add deck: ' + errMsg(e));
    } finally {
      addingDeckIds.delete(deckId);
      renderSearchResults();
    }
  }

  async function loadDecks(): Promise<void> {
    try {
      decks = await listDecksWithCounts();
    } catch (e) {
      toast('Could not load decks: ' + errMsg(e));
      decks = [];
    }
  }

  async function loadStats(): Promise<void> {
    try {
      statsData = await fetchDeckStats(null);
    } catch {
      statsData = null;
    }
    const el = document.getElementById('libStats');
    if (!el) return; // navigated away before this resolved
    el.innerHTML = statsData ? statsHTML(statsData) : '';
    wireStats();
    if (statsData) deps.onStatsLoaded?.(totalDue(), statsData.streak.current);
  }

  function wireStats(): void {
    document.getElementById('moreStatsBtn')?.addEventListener('click', () => {
      showMoreStats = !showMoreStats;
      const el = document.getElementById('statsMore');
      const btn = document.getElementById('moreStatsBtn');
      if (el && statsData) el.innerHTML = showMoreStats ? statsMoreHTML(statsData) : '';
      if (btn) btn.textContent = showMoreStats ? '− Show less' : '+ More stats';
    });
  }

  function statsHTML(data: DeckStatsWithStreak): string {
    return `
      <div class="panelbox">
        <h3>📊 Your stats <span class="stats-scope-note">— across all your decks</span></h3>
        <div class="stat-grid">
          <div class="stat-item"><div class="stat-v">${data.reviews.today}</div><div class="stat-k">reviewed today</div></div>
          <div class="stat-item"><div class="stat-v">${accuracyPct(data.ratingsToday)}%</div><div class="stat-k">accuracy today</div></div>
          <div class="stat-item"><div class="stat-v">🔥 ${data.streak.current}</div><div class="stat-k">current streak</div></div>
          <div class="stat-item"><div class="stat-v">${data.streak.longest}</div><div class="stat-k">longest streak</div></div>
          <div class="stat-item"><div class="stat-v">${data.due.now}</div><div class="stat-k">due now</div></div>
          <div class="stat-item"><div class="stat-v">${data.due.week}</div><div class="stat-k">due in 7 days</div></div>
        </div>
        <button class="more-toggle" id="moreStatsBtn">${showMoreStats ? '− Show less' : '+ More stats'}</button>
        <div id="statsMore">${showMoreStats ? statsMoreHTML(data) : ''}</div>
      </div>
    `;
  }

  await loadDecks();
  render();
  await loadStats();
}
