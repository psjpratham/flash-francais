import { listDecksWithCounts, createDeck, fetchDeckStats } from '../lib/decks';
import type { DeckStatsWithStreak, DeckWithCounts } from '../types';
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
        <div class="grid" id="deckGrid"></div>
      </div>`;

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
        <h3>📊 Your stats</h3>
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
