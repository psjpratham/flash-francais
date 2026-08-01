// Study picker: choose which stack(s) to walk through with no scheduling —
// selection is always whole-stack, never individual cards. An optional tag
// filter narrows which cards actually come along from whatever's selected;
// every stack's displayed count reacts to it live, computed entirely
// client-side (all of the deck's card/tag pairs are fetched once up front)
// so toggling a chip never costs a round-trip. Hands off to studyMode.ts
// exactly the way the old Stacks-page selection flow did.
//
// One tile per import here too (see StackTile in lib/stacks.ts) — selecting
// a tile selects every underlying stack it represents; studyMode.ts never
// sees the difference.

import { fetchDeckTags } from '../lib/decks';
import { listCardTagsForDeck, listStackTilesForDeck, type StackCardTags, type StackTile } from '../lib/stacks';
import type { DeckTagCount } from '../types';
import { $, errMsg, esc } from '../lib/dom';

export interface StudyPickerDeps {
  onBack: () => void;
  deckId: string;
  deckName: string;
  /** `tileCount` is how many tiles the learner actually picked here — Study mode's header should echo that number back (see studyMode.ts's title), not the raw count of underlying per-page `stacks` rows those tiles expand to (stackIds.length), which can run well ahead of what was actually clicked. */
  onStudySelected: (stackIds: string[], tagFilter: string[], tileCount: number) => void;
}

export async function renderStudyPicker(container: HTMLElement, deps: StudyPickerDeps): Promise<void> {
  let tiles: StackTile[] | null = null;
  let cardTags: StackCardTags[] = [];
  let deckTags: DeckTagCount[] | null = null;
  let loadError: string | null = null;

  let tagFilter: string[] = [];
  let selectedTileIds = new Set<string>();

  function render(): void {
    container.innerHTML = `
      <div class="wrap" style="padding-bottom:100px">
        <button class="back-link" id="backBtn">← ${esc(deps.deckName)}</button>
        <div class="page-h"><h1>📖 Study</h1><p>Pick which stack(s) to walk through, in order — no scheduling, just reading.</p></div>
        <div id="tagFilterBody"></div>
        <div id="pickerBody">${renderBody()}</div>
      </div>
      <div class="study-selection-bar ${selectedTileIds.size ? '' : 'hide'}" id="selectionBar"></div>`;
    $(container, '#backBtn').addEventListener('click', deps.onBack);
    renderTagFilterBody();
    renderSelectionBar();
    wireBody();
  }

  // ---------- tag filter (always visible — narrows whatever gets selected below) ----------

  function renderTagFilterBody(): void {
    const el = document.getElementById('tagFilterBody');
    if (!el) return;
    el.innerHTML = `
      <div class="panelbox">
        <h3>Filter by tag <span style="font-weight:400;color:var(--ink-faint);font-size:12.5px">(matches any tag selected — narrows every stack's count below)</span></h3>
        ${deckTags ? tagBarHTML() : '<div class="stats-loading">Loading tags…</div>'}
      </div>`;
    wireTagFilterBody();
    if (!deckTags) void loadDeckTags();
  }

  function tagBarHTML(): string {
    if (!deckTags?.length) return `<p style="font-size:12.5px;color:var(--ink-faint)">No tags on this deck's cards yet.</p>`;
    return `<div class="tagbar">${deckTags
      .map((t) => `<button class="${tagFilter.includes(t.tag) ? 'on' : ''}" data-tag="${esc(t.tag)}">${esc(t.tag)} <span style="opacity:.6">${t.count}</span></button>`)
      .join('')}</div>`;
  }

  async function loadDeckTags(): Promise<void> {
    try {
      deckTags = await fetchDeckTags(deps.deckId);
    } catch {
      deckTags = [];
    }
    renderTagFilterBody();
  }

  function wireTagFilterBody(): void {
    document.querySelectorAll<HTMLElement>('.tagbar button[data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag!;
        const i = tagFilter.indexOf(tag);
        if (i >= 0) tagFilter.splice(i, 1);
        else tagFilter.push(tag);
        // Counts everywhere below depend on tagFilter — re-render the whole list, not just the chip bar.
        const body = document.getElementById('pickerBody');
        if (body) {
          body.innerHTML = renderBody();
          wireBody();
        }
        renderTagFilterBody();
        renderSelectionBar();
      });
    });
  }

  // ---------- counts ----------

  /** Cards in this tile matching the active tag filter (summed across every stack it represents) — or its plain total when no filter is set. */
  function countFor(tile: StackTile): number {
    if (!tagFilter.length) return tile.cardCount;
    return cardTags.filter((c) => tile.stackIds.includes(c.stackId) && c.tags.some((t) => tagFilter.includes(t))).length;
  }

  // ---------- selection bar ----------

  function renderSelectionBar(): void {
    const el = document.getElementById('selectionBar');
    if (!el) return;
    if (!selectedTileIds.size) {
      el.className = 'study-selection-bar hide';
      el.innerHTML = '';
      return;
    }
    const totalCards = tiles ? [...selectedTileIds].reduce((sum, id) => sum + (countFor(tiles!.find((t) => t.id === id)!) ?? 0), 0) : 0;
    el.className = 'study-selection-bar';
    el.innerHTML = `
      <div class="study-selection-bar-inner">
        <span>${selectedTileIds.size} stack${selectedTileIds.size === 1 ? '' : 's'} selected · ${totalCards} card${totalCards === 1 ? '' : 's'} to study</span>
        <div class="row">
          <button class="btn-sec" id="clearSelectionBtn">Clear</button>
          <button class="btn-primary" style="width:auto" id="studySelectedBtn">📖 Study selected</button>
        </div>
      </div>`;
    document.getElementById('clearSelectionBtn')?.addEventListener('click', () => {
      selectedTileIds = new Set();
      const body = document.getElementById('pickerBody');
      if (body) {
        body.innerHTML = renderBody();
        wireBody();
      }
      renderSelectionBar();
    });
    document.getElementById('studySelectedBtn')?.addEventListener('click', () => {
      const stackIds = (tiles ?? []).filter((t) => selectedTileIds.has(t.id)).flatMap((t) => t.stackIds);
      deps.onStudySelected(stackIds, tagFilter, selectedTileIds.size);
    });
  }

  // ---------- tile list ----------

  function renderBody(): string {
    if (loadError) return `<div class="panelbox">Could not load stacks: ${esc(loadError)}</div>`;
    if (!tiles) return `<div class="stats-loading">Loading stacks…</div>`;
    // A tile with 0 cards has nothing to study — nothing to do here.
    const studyableTiles = tiles.filter((t) => t.cardCount > 0);
    if (!studyableTiles.length) return `<div class="panelbox"><p class="p-text">No stacks yet — there's nothing to study.</p></div>`;

    const importTiles = studyableTiles.filter((t) => t.isImport);
    const handMadeTiles = studyableTiles.filter((t) => !t.isImport);

    return `
      ${importTiles.length ? section('📚 Imports', 'imports', importTiles) : ''}
      ${handMadeTiles.length ? section('🗂️ Stacks made by hand', 'hand', handMadeTiles) : ''}
    `;
  }

  function section(heading: string, groupKey: string, items: StackTile[]): string {
    return `
      <div class="panelbox">
        <div class="stack-group-header-static">
          <h3 style="margin:0">${heading}</h3>
          ${selectAllButtonHTML(groupKey, items)}
        </div>
        <div class="stack-grid">${items.map(tilePickHTML).join('')}</div>
      </div>`;
  }

  function selectAllButtonHTML(groupKey: string, items: StackTile[]): string {
    const allSelected = items.length > 0 && items.every((t) => selectedTileIds.has(t.id));
    return `<button class="btn-sec" data-select-all="${esc(groupKey)}">${allSelected ? '✕ Deselect all' : '☑ Select all'}</button>`;
  }

  function tilePickHTML(tile: StackTile): string {
    const checked = selectedTileIds.has(tile.id);
    const count = countFor(tile);
    const zeroMatch = tagFilter.length > 0 && count === 0;
    return `
      <div class="stack-card stack-card-selectable ${checked ? 'stack-card-selected' : ''} ${zeroMatch ? 'stack-card-muted' : ''}" data-tile-id="${esc(tile.id)}" role="checkbox" aria-checked="${checked}" tabindex="0">
        <div class="stack-card-top">
          <span class="stack-card-icon">${tile.isImport ? '📚' : '🗂️'}</span>
          <span class="stack-card-check" aria-hidden="true">✓</span>
        </div>
        <div class="stack-card-title">${esc(tile.name)}</div>
        <div class="stack-card-meta">
          <span>${tagFilter.length ? `${count} / ${tile.cardCount} match` : `${tile.cardCount} card${tile.cardCount === 1 ? '' : 's'}`}</span>
        </div>
      </div>`;
  }

  function wireBody(): void {
    container.querySelectorAll<HTMLElement>('.stack-card[data-tile-id]').forEach((card) => {
      const id = card.dataset.tileId!;
      const toggle = (): void => {
        const nowSelected = !selectedTileIds.has(id);
        if (nowSelected) selectedTileIds.add(id);
        else selectedTileIds.delete(id);
        card.classList.toggle('stack-card-selected', nowSelected);
        card.setAttribute('aria-checked', String(nowSelected));
        renderSelectionBar();
      };
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
    container.querySelectorAll<HTMLButtonElement>('[data-select-all]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupKey = btn.dataset.selectAll!;
        if (!tiles) return;
        const studyableTiles = tiles.filter((t) => t.cardCount > 0);
        const items = groupKey === 'hand' ? studyableTiles.filter((t) => !t.isImport) : studyableTiles.filter((t) => t.isImport);
        const allSelected = items.length > 0 && items.every((t) => selectedTileIds.has(t.id));
        for (const t of items) {
          if (allSelected) selectedTileIds.delete(t.id);
          else selectedTileIds.add(t.id);
        }
        const body = document.getElementById('pickerBody');
        if (body) {
          body.innerHTML = renderBody();
          wireBody();
        }
        renderSelectionBar();
      });
    });
  }

  async function load(): Promise<void> {
    try {
      const [tileList, tags] = await Promise.all([listStackTilesForDeck(deps.deckId), listCardTagsForDeck(deps.deckId)]);
      tiles = tileList;
      cardTags = tags;
    } catch (e) {
      loadError = errMsg(e);
    }
    const body = document.getElementById('pickerBody');
    if (body) {
      body.innerHTML = renderBody();
      wireBody();
    }
    renderSelectionBar();
  }

  render();
  await load();
}
