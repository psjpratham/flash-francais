import { fetchDeckStats, fetchDeckTags, getDeckWithCounts } from '../lib/decks';
import { bulkInsertNotesAndCards } from '../lib/cards';
import type { ImportItem } from '../lib/cards';
import type { DeckStatsWithStreak, DeckTagCount, DeckWithCounts } from '../types';
import { $, errMsg, esc, toast } from '../lib/dom';
import { accuracyPct, statsMoreHTML } from './statsPanel';

export interface DeckDetailDeps {
  onBack: () => void;
  onStartSession: (deck: DeckWithCounts, tagFilter: string[]) => void;
  onReadBook: () => void;
}

type ImportTab = 'paste' | 'json' | 'manual';

export async function renderDeckDetail(container: HTMLElement, deckId: string, deps: DeckDetailDeps): Promise<void> {
  let deck: DeckWithCounts | null = null;
  let showImport = false;
  let importTab: ImportTab = 'paste';
  let showTagFilter = false;
  let tagFilter: string[] = [];
  let deckTags: DeckTagCount[] | null = null;
  let statsData: DeckStatsWithStreak | null = null;
  let showMoreStats = false;

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
    const filterActive = tagFilter.length > 0;
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
          <button class="btn-sec" id="readBookBtn">📖 Read this unit</button>
          <button class="btn-sec" id="toggleTagFilterBtn">🏷️ ${filterActive ? `Filter (${tagFilter.length})` : 'Filter by tag'}</button>
          <button class="btn-sec" id="toggleImportBtn">${showImport ? '− Hide import' : '+ Import cards'}</button>
        </div>

        <div id="tagFilterSection" class="${showTagFilter ? '' : 'hide'}" style="margin-top:18px"></div>

        <div id="deckStats" style="margin-top:18px"><div class="stats-loading">Crunching numbers…</div></div>

        <div id="importSection" class="${showImport ? '' : 'hide'}" style="margin-top:18px">
          <div class="panelbox">
            <h3>Add cards</h3>
            <div class="tabs">
              <button class="${importTab === 'paste' ? 'on' : ''}" data-tab="paste">Paste front⇥back</button>
              <button class="${importTab === 'json' ? 'on' : ''}" data-tab="json">Upload JSON</button>
              <button class="${importTab === 'manual' ? 'on' : ''}" data-tab="manual">Add one</button>
            </div>
            <div id="importBody"></div>
          </div>
        </div>
      </div>`;

    $(container, '#backBtn').addEventListener('click', deps.onBack);
    $(container, '#startSessionBtn').addEventListener('click', () => deps.onStartSession(deck!, tagFilter));
    $(container, '#readBookBtn').addEventListener('click', deps.onReadBook);
    $(container, '#toggleTagFilterBtn').addEventListener('click', () => {
      showTagFilter = !showTagFilter;
      render();
    });
    $(container, '#toggleImportBtn').addEventListener('click', () => {
      showImport = !showImport;
      render();
    });
    container.querySelectorAll<HTMLElement>('.tabs button[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        importTab = btn.dataset.tab as ImportTab;
        render();
      });
    });

    renderImportBody();
    if (showTagFilter) void renderTagFilterSection();
    renderStatsSection();
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

  // ---------- import ----------

  function renderImportBody(): void {
    const el = document.getElementById('importBody');
    if (!el) return;
    if (importTab === 'paste') {
      el.innerHTML = `
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:8px">One card per line: <code>front</code> [Tab] <code>back</code></p>
        <textarea class="bulk" id="pasteArea" placeholder="chat&#9;cat&#10;maison&#9;house"></textarea>
        <div class="row"><button class="btn-sec" id="importPasteBtn">Import</button></div>`;
      document.getElementById('importPasteBtn')?.addEventListener('click', () => void importPaste());
    } else if (importTab === 'json') {
      el.innerHTML = `
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:8px">Upload a JSON array of cards (front/back/ipa/decl/example/wiktionary — extra fields are shown as chips).</p>
        <div class="filedrop" id="fileDropZone">Click to choose a .json file</div>
        <input type="file" id="jsonFile" accept=".json" class="hide">`;
      const fileInput = $<HTMLInputElement>(el, '#jsonFile');
      $(el, '#fileDropZone').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => importJSONFile(fileInput.files?.[0]));
    } else {
      el.innerHTML = `
        <div class="field"><label>Front</label><input id="manFront"></div>
        <div class="field"><label>Back</label><input id="manBack"></div>
        <div class="row"><button class="btn-sec" id="importManualBtn">Add card</button></div>`;
      document.getElementById('importManualBtn')?.addEventListener('click', () => void importManual());
    }
  }

  async function importPaste(): Promise<void> {
    if (!deck) return;
    const textarea = $<HTMLTextAreaElement>(container, '#pasteArea');
    const lines = textarea.value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const items: ImportItem[] = lines
      .map((l) => {
        const [f, b] = l.split('\t');
        return { front: (f ?? '').trim(), back: (b ?? '').trim() };
      })
      .filter((x) => x.front);
    if (!items.length) {
      toast('Nothing to import');
      return;
    }
    toast(`Importing ${items.length} cards…`);
    try {
      await bulkInsertNotesAndCards(deck.id, 'basic', items);
      toast(`Imported ${items.length} cards`);
      await refreshAfterImport();
    } catch (e) {
      toast('Import failed: ' + errMsg(e));
    }
  }

  function importJSONFile(file: File | undefined): void {
    if (!file || !deck) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      void (async () => {
        try {
          const arr = JSON.parse(String(e.target?.result));
          if (!Array.isArray(arr)) throw new Error('JSON must be an array of card objects');
          toast(`Importing ${arr.length} cards…`);
          await bulkInsertNotesAndCards(deck!.id, 'anki', arr as ImportItem[]);
          toast(`Imported ${arr.length} cards`);
          await refreshAfterImport();
        } catch (err) {
          toast('Import failed: ' + errMsg(err));
        }
      })();
    };
    reader.readAsText(file);
  }

  async function importManual(): Promise<void> {
    if (!deck) return;
    const frontInput = $<HTMLInputElement>(container, '#manFront');
    const backInput = $<HTMLInputElement>(container, '#manBack');
    const front = frontInput.value.trim();
    const back = backInput.value.trim();
    if (!front) {
      toast('Enter a front');
      return;
    }
    try {
      await bulkInsertNotesAndCards(deck.id, 'basic', [{ front, back }]);
      toast('Card added');
      frontInput.value = '';
      backInput.value = '';
    } catch (e) {
      toast('Could not add card: ' + errMsg(e));
    }
  }

  async function refreshAfterImport(): Promise<void> {
    if (!deck) return;
    try {
      deck = await getDeckWithCounts(deck.id);
    } catch {
      /* keep showing the previous counts if the refetch fails */
    }
    render();
    await loadStats();
  }

  await load();
}
