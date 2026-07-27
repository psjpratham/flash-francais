import { bulkInsertNotesAndCards } from '../lib/cards';
import type { ImportItem } from '../lib/cards';
import { classifyImportError } from '../lib/importErrors';
import { createImport, createImportFileRecord, enqueuePreprocessing, IMPORT_SOURCES, updateImportFileStatus, uploadImportSourceFile } from '../lib/imports';
import { STAGE, type ImportProgress } from '../lib/importProgress';
import type { ImportSourceType } from '../types';
import { $, errMsg, esc, toast } from '../lib/dom';
import { renderImportProgress } from './importProgressView';

export interface ImportContentDeps {
  /** Returns to this deck's detail page — the import flow never navigates to the library. */
  onBack: () => void;
  /** Fired the moment an import row + its files are persisted — the caller navigates to the durable import-detail route right away, per "never lose access to an in-flight import". */
  onImportCreated: (importId: string) => void;
  deckId: string;
  deckName: string;
  /** Gates the "Textbook PDF" option — creating an import row requires admin, same as RLS enforces server-side. */
  isAdmin: boolean;
}

type Mode = 'loading' | 'chooser' | 'textbook' | 'cards';
type CardsTab = 'paste' | 'json' | 'manual';

/**
 * Deck-scoped "Import content" flow: either starts a brand new textbook
 * import (upload -> enqueue preprocessing -> hand off to the durable
 * import-detail route immediately) or the cards/JSON quick-add flow.
 * Existing/in-flight textbook imports are never resumed here — that's the
 * deck's "Document imports" list + the import-detail page's job, driven by
 * a real import_id, never "whatever this flow last touched".
 */
export function renderImportContent(container: HTMLElement, deps: ImportContentDeps): void {
  const { deckId } = deps;
  let mode: Mode = 'chooser';
  let busy = false;
  let startError: string | null = null;
  let forceImageOnly = false;

  let cardsTab: CardsTab = 'paste';
  let cardsProgress: ImportProgress | null = null;

  // ---------- render ----------

  function render(): void {
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← ${esc(deps.deckName)}</button>
        <div class="page-h">
          <h1>Import content</h1>
          <p>Adds content to <strong>${esc(deps.deckName)}</strong>. This never creates another deck.</p>
        </div>
        <div id="importBody"></div>
      </div>`;
    $(container, '#backBtn').addEventListener('click', deps.onBack);
    renderBody();
  }

  function renderBody(): void {
    const el = document.getElementById('importBody');
    if (!el) return;
    if (mode === 'chooser') {
      el.innerHTML = renderChooser();
      wireChooser();
      return;
    }
    if (mode === 'cards') {
      el.innerHTML = renderCards();
      wireCards();
      return;
    }
    el.innerHTML = renderTextbookStart();
    wireTextbook();
  }

  // ---------- type chooser ----------

  function renderChooser(): string {
    return `
      <div class="panelbox">
        <h3>What are you importing?</h3>
        <div class="import-type-choice">
          ${
            deps.isAdmin
              ? `<button id="chooseTextbookBtn"><span class="t">📘 Textbook PDF</span><span class="d">Upload a textbook PDF (+ optional audio files) and extract each page faithfully for review.</span></button>`
              : ''
          }
          <button id="chooseCardsBtn"><span class="t">🗂️ Cards / JSON</span><span class="d">Paste front⇥back lines, upload a JSON file, or add a card by hand.</span></button>
        </div>
      </div>`;
  }

  function wireChooser(): void {
    document.getElementById('chooseTextbookBtn')?.addEventListener('click', () => {
      mode = 'textbook';
      render();
    });
    document.getElementById('chooseCardsBtn')?.addEventListener('click', () => {
      mode = 'cards';
      render();
    });
  }

  // ---------- textbook flow: upload -> enqueue -> hand off ----------

  function renderTextbookStart(): string {
    return `
      <div class="panelbox">
        <h3>Upload textbook PDF</h3>
        ${startError ? `<div class="auth-err">${esc(startError)}</div>` : ''}
        ${IMPORT_SOURCES.map(
          (s) => `
          <div class="field">
            <label>${esc(s.label)}${!s.required ? ' (optional)' : ''}</label>
            <input type="file" id="file-${s.type}" accept="application/pdf,.pdf">
          </div>`,
        ).join('')}
        <label class="checkbox-field">
          <input type="checkbox" id="forceImageOnlyCheckbox" ${forceImageOnly ? 'checked' : ''}>
          Force image-only extraction (test mode — skips the PDF text layer entirely, so every page is read straight off its image, same as a scanned page)
        </label>
        <button class="btn-primary" id="startTextbookBtn" ${busy ? 'disabled' : ''}>${busy ? 'Uploading…' : 'Start import'}</button>
        <button class="btn-sec" id="backToChooserBtn" ${busy ? 'disabled' : ''}>← Choose a different type</button>
      </div>`;
  }

  function wireTextbook(): void {
    document.getElementById('startTextbookBtn')?.addEventListener('click', () => void startTextbookImport());
    document.getElementById('backToChooserBtn')?.addEventListener('click', () => {
      mode = 'chooser';
      render();
    });
    document.getElementById('forceImageOnlyCheckbox')?.addEventListener('change', (e) => {
      forceImageOnly = (e.target as HTMLInputElement).checked;
    });
  }

  async function startTextbookImport(): Promise<void> {
    startError = null;
    const selectedFiles: Partial<Record<ImportSourceType, File>> = {};
    for (const s of IMPORT_SOURCES) {
      const input = $<HTMLInputElement>(container, `#file-${s.type}`);
      const file = input.files?.[0];
      if (!file) {
        if (s.required) {
          startError = `Choose a file for "${s.label}".`;
          render();
          return;
        }
        continue;
      }
      selectedFiles[s.type] = file;
    }

    busy = true;
    render();

    let importId: string;
    try {
      const imp = await createImport(deckId, deps.deckName, forceImageOnly);
      importId = imp.id;
    } catch (e) {
      startError = 'Could not start import: ' + errMsg(e);
      busy = false;
      render();
      return;
    }

    for (const s of IMPORT_SOURCES) {
      const file = selectedFiles[s.type];
      if (!file) continue;
      try {
        const rec = await createImportFileRecord(importId, s.type, file);
        await updateImportFileStatus(rec.id, 'uploading');
        await uploadImportSourceFile(rec.storage_path, file);
        await updateImportFileStatus(rec.id, 'completed');
      } catch (e) {
        const cls = await classifyImportError(e);
        startError = `Could not upload ${s.label}: ${cls.message}`;
        busy = false;
        render();
        return;
      }
    }

    // Persist-and-hand-off: queue preprocessing (a fast DB insert, not a
    // long-running call) and immediately navigate to the durable import
    // route — the browser's job here is done. All further progress is
    // driven entirely by the server-side dispatcher from this point on.
    try {
      await enqueuePreprocessing(importId, deckId);
    } catch (e) {
      toast('Could not queue preprocessing: ' + errMsg(e) + ' — you can retry from the import page.');
    }

    busy = false;
    deps.onImportCreated(importId);
  }

  // ---------- cards / json flow (unchanged — synchronous, no durability concerns) ----------

  function renderCards(): string {
    return `
      <div class="panelbox">
        <h3>Add cards</h3>
        <div class="tabs">
          <button class="${cardsTab === 'paste' ? 'on' : ''}" data-tab="paste">Paste front⇥back</button>
          <button class="${cardsTab === 'json' ? 'on' : ''}" data-tab="json">Upload JSON</button>
          <button class="${cardsTab === 'manual' ? 'on' : ''}" data-tab="manual">Add one</button>
        </div>
        <div id="cardsTabBody"></div>
        <div id="cardsProgressBody"></div>
      </div>`;
  }

  function wireCards(): void {
    document.querySelectorAll<HTMLElement>('.tabs button[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cardsTab = btn.dataset.tab as CardsTab;
        render();
      });
    });
    renderCardsTabBody();
    renderCardsProgressBody();
  }

  function renderCardsTabBody(): void {
    const el = document.getElementById('cardsTabBody');
    if (!el) return;
    if (cardsTab === 'paste') {
      el.innerHTML = `
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:8px">One card per line: <code>front</code> [Tab] <code>back</code></p>
        <textarea class="bulk" id="pasteArea" placeholder="chat&#9;cat&#10;maison&#9;house"></textarea>
        <div class="row"><button class="btn-sec" id="importPasteBtn">Import</button></div>`;
      document.getElementById('importPasteBtn')?.addEventListener('click', () => void importPaste());
    } else if (cardsTab === 'json') {
      el.innerHTML = `
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:8px">Upload a JSON array of cards (front/back/ipa/decl/example/wiktionary — extra fields are shown as chips).</p>
        <div class="filedrop" id="fileDropZone">Click to choose a .json file</div>
        <input type="file" id="jsonFile" accept=".json" class="hide">`;
      const fileInput = $<HTMLInputElement>(el, '#jsonFile');
      $(el, '#fileDropZone').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => void importJSONFile(fileInput.files?.[0]));
    } else {
      el.innerHTML = `
        <div class="field"><label>Front</label><input id="manFront"></div>
        <div class="field"><label>Back</label><input id="manBack"></div>
        <div class="row"><button class="btn-sec" id="importManualBtn">Add card</button></div>`;
      document.getElementById('importManualBtn')?.addEventListener('click', () => void importManual());
    }
  }

  function renderCardsProgressBody(): void {
    const el = document.getElementById('cardsProgressBody');
    if (!el) return;
    el.innerHTML = cardsProgress ? `<div style="margin-top:14px">${renderImportProgress(cardsProgress)}</div>` : '';
  }

  function setCardsProgress(p: ImportProgress): void {
    cardsProgress = p;
    renderCardsProgressBody();
  }

  async function runCardsImport(stageMessage: string, total: number | null, run: () => Promise<number>): Promise<void> {
    setCardsProgress({
      status: 'running',
      currentStage: STAGE.EXTRACTING,
      totalUnits: total,
      completedUnits: 0,
      failedUnits: 0,
      percent: total == null ? 35 : 0,
      indeterminate: true,
      message: stageMessage,
    });
    try {
      const count = await run();
      setCardsProgress({
        status: 'completed',
        currentStage: STAGE.READY,
        totalUnits: count,
        completedUnits: count,
        failedUnits: 0,
        percent: 100,
        indeterminate: false,
        message: `Imported ${count} card(s).`,
      });
    } catch (e) {
      const cls = await classifyImportError(e);
      setCardsProgress({
        status: 'failed',
        currentStage: STAGE.EXTRACTING,
        totalUnits: total,
        completedUnits: 0,
        failedUnits: total ?? 1,
        percent: 35,
        indeterminate: false,
        message: cls.message,
        errorCategory: cls.category,
        errorDetail: cls.detail,
      });
    }
  }

  async function importPaste(): Promise<void> {
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
    await runCardsImport(`Importing ${items.length} card(s)…`, items.length, async () => {
      await bulkInsertNotesAndCards(deckId, 'basic', items);
      return items.length;
    });
  }

  async function importJSONFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setCardsProgress({
      status: 'running',
      currentStage: STAGE.READING,
      totalUnits: null,
      completedUnits: 0,
      failedUnits: 0,
      percent: 15,
      indeterminate: true,
      message: 'Reading file…',
    });
    const text = await file.text();
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      setCardsProgress({
        status: 'failed',
        currentStage: STAGE.READING,
        totalUnits: null,
        completedUnits: 0,
        failedUnits: 1,
        percent: 15,
        indeterminate: false,
        message: 'The file is not valid JSON.',
        errorDetail: errMsg(e),
      });
      return;
    }
    if (!Array.isArray(arr)) {
      setCardsProgress({
        status: 'failed',
        currentStage: STAGE.READING,
        totalUnits: null,
        completedUnits: 0,
        failedUnits: 1,
        percent: 20,
        indeterminate: false,
        message: 'JSON must be an array of card objects.',
      });
      return;
    }
    await runCardsImport(`Importing ${arr.length} card(s)…`, arr.length, async () => {
      await bulkInsertNotesAndCards(deckId, 'anki', arr as ImportItem[]);
      return arr.length;
    });
  }

  async function importManual(): Promise<void> {
    const frontInput = $<HTMLInputElement>(container, '#manFront');
    const backInput = $<HTMLInputElement>(container, '#manBack');
    const front = frontInput.value.trim();
    const back = backInput.value.trim();
    if (!front) {
      toast('Enter a front');
      return;
    }
    try {
      await bulkInsertNotesAndCards(deckId, 'basic', [{ front, back }]);
      toast('Card added');
      frontInput.value = '';
      backInput.value = '';
    } catch (e) {
      const cls = await classifyImportError(e);
      toast('Could not add card: ' + cls.message);
    }
  }

  render();
}
