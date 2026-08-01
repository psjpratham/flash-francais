import { bulkInsertNotesAndCards } from '../lib/cards';
import type { ImportItem } from '../lib/cards';
import { classifyImportError } from '../lib/importErrors';
import { createImport, createImportFileRecord, createPromptOnlyImport, enqueuePreprocessing, IMPORT_SOURCES, updateImportFileStatus, uploadImportSourceFile } from '../lib/imports';
import { STAGE, type ImportProgress } from '../lib/importProgress';
import { fetchYoutubeTranscript } from '../lib/youtubeTranscript';
import { $, errMsg, esc, toast } from '../lib/dom';
import { renderImportProgress } from './importProgressView';

export interface ImportContentDeps {
  /** Returns to this deck's detail page — the import flow never navigates to the library. */
  onBack: () => void;
  /** Fired the moment an import row + its files are persisted — the caller navigates to the durable import-detail route right away, per "never lose access to an in-flight import". */
  onImportCreated: (importId: string) => void;
  deckId: string;
  deckName: string;
  /** Gates the "force image-only extraction" test-mode checkbox — a debug knob, not something regular users should see or toggle. */
  isAdmin: boolean;
}

type Mode = 'chooser' | 'cards' | 'anki';
type CardsTab = 'paste' | 'json' | 'manual';

type SourceKind = 'image' | 'pdf' | 'doc';

/**
 * 'faithful': reproduce the source exactly, no prompt, cards never get
 * front/back/answers unless an attached answer key (corrigé) covers a given
 * exercise. 'prompt': describe how to shape the cards — always required
 * (attaching a source with no prompt is no longer "faithful by default",
 * it's just incomplete) — see handleComposerSend.
 */
type ExtractionMode = 'faithful' | 'prompt';

const SOURCE_PILLS: { kind: SourceKind; icon: string; label: string; accept: string }[] = [
  { kind: 'image', icon: '🖼️', label: 'Image', accept: 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif' },
  { kind: 'pdf', icon: '📄', label: 'PDF', accept: 'application/pdf,.pdf' },
  { kind: 'doc', icon: '📝', label: 'Text/Doc', accept: 'text/plain,.txt,.doc,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
];

const CORRIGE_ACCEPT = 'application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif';

const PROMPT_SUGGESTIONS = [
  'Make vocabulary flashcards from this',
  'Create fill-in-the-blank practice from this',
  'Focus on the key grammar rules',
  'Turn this into short quiz questions',
];

/** Best-effort client-side classification, mirroring preprocessWorker.ts's isPdf/isImage — used only to enforce "one source type per import" and decide the deterministic merged-stack behavior; the server does its own real validation regardless. */
function classifyFileKind(file: File): SourceKind {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name)) return 'image';
  return 'doc';
}

const MAX_TITLE_LEN = 60;

/**
 * This import's own title — used for both imports.title and, for an
 * image-source import, the shared stack's name (see createImport). Never
 * the deck name: a deck can hold many imports, and every one of them
 * getting the same deck-named stack was indistinguishable in the Stacks/
 * Study browsers. Prompt mode uses the prompt itself (what the student
 * actually asked for is the most meaningful label available); faithful
 * mode uses the attached file name(s), since there's no prompt to draw from.
 */
function deriveImportTitle(files: File[], mode: ExtractionMode, prompt: string | undefined): string {
  if (mode === 'prompt' && prompt) {
    return prompt.length > MAX_TITLE_LEN ? `${prompt.slice(0, MAX_TITLE_LEN - 1)}…` : prompt;
  }
  const base = (files[0]?.name ?? 'Import').replace(/\.[^./]+$/, '');
  return files.length > 1 ? `${base} +${files.length - 1} more` : base;
}

/**
 * Deck-scoped "Import content" flow. The chooser is one ChatGPT-style
 * composer — pick faithful or prompt-driven extraction, attach a source
 * (image, PDF, or text/doc — an import may only contain one of these kinds,
 * picked via the pills below the box), and either leave it at that
 * (faithful, optionally with an answer key attached) or describe how the
 * cards should be shaped (prompt mode, always wired — see
 * preprocessWorker.ts's custom_prompt threading). A prompt with NO source
 * attached also works — cards are generated entirely from the model's own
 * knowledge, grounded by the prompt (see createPromptOnlyImport). A YouTube
 * link is real too — its transcript (fetched via fetch-youtube-transcript,
 * see startYoutubeImport) is wrapped as a synthetic .txt file and sent
 * through the exact same doc-upload pipeline as an attached text file.
 * Anki import remains an honest UI-only stub until its backend exists.
 */
export function renderImportContent(container: HTMLElement, deps: ImportContentDeps): void {
  const { deckId } = deps;
  let mode: Mode = 'chooser';
  let busy = false;
  let startError: string | null = null;
  let forceImageOnly = true;

  let extractionMode: ExtractionMode = 'prompt';
  let promptText = '';
  let attachedFiles: File[] = [];
  // Faithful mode only — an optional answer key uploaded alongside the main
  // source(s), never counted against the "one source type per import" lock.
  let corrigeFile: File | null = null;
  let showYoutubeInput = false;
  let youtubeUrl = '';

  let cardsTab: CardsTab = 'paste';
  let cardsProgress: ImportProgress | null = null;

  // ---------- render ----------

  function render(): void {
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← ${esc(deps.deckName)}</button>
        <div class="page-h">
          <h1>Import content</h1>
          <p>Adds content to <strong>${esc(deps.deckName)}</strong>.</p>
        </div>
        <div id="importBody"></div>
      </div>`;
    $(container, '#backBtn').addEventListener('click', deps.onBack);
    renderBody();
  }

  function renderBody(): void {
    const el = document.getElementById('importBody');
    if (!el) return;
    if (mode === 'cards') {
      el.innerHTML = renderCards();
      wireCards();
      return;
    }
    if (mode === 'anki') {
      el.innerHTML = renderAnki();
      wireAnki();
      return;
    }
    el.innerHTML = renderChooser();
    wireChooser();
  }

  // ---------- chooser: mode split + composer + two file-import options ----------

  /** The kind every currently-attached source file is locked to, or null when nothing's attached yet (any pill still selectable). */
  function lockedKind(): SourceKind | null {
    return attachedFiles.length ? classifyFileKind(attachedFiles[0]) : null;
  }

  function canSend(): boolean {
    if (busy) return false;
    if (youtubeUrl.trim()) {
      // Same rule as an attached file: prompt mode needs a prompt describing
      // how to shape the cards; faithful mode just needs the link itself.
      return extractionMode === 'faithful' || promptText.trim().length > 0;
    }
    if (extractionMode === 'faithful') return attachedFiles.length > 0;
    // prompt mode: a prompt is required whenever anything's attached; a
    // prompt with no source at all is the honest "coming soon" stub path,
    // still sendable so the toast in handleComposerSend can explain that.
    return promptText.trim().length > 0;
  }

  function renderChooser(): string {
    const locked = lockedKind();
    const attachmentChips = attachedFiles.map((f, i) => `<span class="composer-chip">📎 ${esc(f.name)} <button type="button" data-remove-file="${i}" title="Remove">✕</button></span>`).join('');
    const youtubeChip = !attachedFiles.length && youtubeUrl.trim() ? `<span class="composer-chip">▶️ ${esc(youtubeUrl.trim())} <button type="button" id="removeAttachmentBtn" title="Remove">✕</button></span>` : '';
    const corrigeChip = corrigeFile ? `<span class="composer-chip">📋 ${esc(corrigeFile.name)} <button type="button" id="removeCorrigeBtn" title="Remove">✕</button></span>` : '';
    const allChips = attachmentChips + youtubeChip + corrigeChip;

    return `
        <div class="composer-wrap">
          ${startError ? `<div class="auth-err" style="margin-bottom:10px">${esc(startError)}</div>` : ''}

          <div class="composer-mode-row">
            <button type="button" class="composer-mode-btn ${extractionMode === 'faithful' ? 'on' : ''}" data-extraction-mode="faithful" ${busy ? 'disabled' : ''}>📚 Faithful extraction</button>
            <button type="button" class="composer-mode-btn ${extractionMode === 'prompt' ? 'on' : ''}" data-extraction-mode="prompt" ${busy ? 'disabled' : ''}>✨ Generate with a prompt</button>
          </div>

          ${
            extractionMode === 'prompt'
              ? `<div class="composer-box">
                   ${allChips ? `<div class="composer-attachments">${allChips}</div>` : ''}
                   <textarea id="promptTextarea" class="composer-textarea" rows="2" placeholder="Describe the cards you want — e.g. &quot;make vocabulary flashcards from this&quot;." ${busy ? 'disabled' : ''}>${esc(promptText)}</textarea>
                   <div class="composer-toolbar">
                     <span class="composer-toolbar-hint">${(attachedFiles.length || youtubeUrl.trim()) && !promptText.trim() ? 'Add a prompt describing how to shape these cards' : ''}</span>
                     <button type="button" class="composer-send-btn" id="composerSendBtn" ${canSend() ? '' : 'disabled'} title="Create">${busy ? '…' : '➤'}</button>
                   </div>
                 </div>
                 <div class="composer-suggestion-pills">
                   ${PROMPT_SUGGESTIONS.map((s) => `<button type="button" class="suggestion-pill" data-suggestion="${esc(s)}" ${busy ? 'disabled' : ''}>${esc(s)}</button>`).join('')}
                 </div>`
              : allChips
                ? `<div class="composer-attachments composer-attachments-plain">${allChips}</div>`
                : ''
          }

          <div class="composer-source-pills">
            ${SOURCE_PILLS.map(
              (p) =>
                `<button type="button" class="source-pill" data-source-kind="${p.kind}" ${busy || (locked && locked !== p.kind) ? 'disabled' : ''} title="${locked && locked !== p.kind ? 'Remove attached files to switch source type' : `Attach ${p.label.toLowerCase()} — an import can only hold one source type`}">${p.icon} ${esc(p.label)}</button>`,
            ).join('')}
            <button type="button" class="source-pill" id="youtubePillBtn" ${busy ? 'disabled' : ''} title="Attach a YouTube link — its transcript is fetched automatically">▶️ YouTube link</button>
            ${
              extractionMode === 'faithful'
                ? `<button type="button" class="source-pill source-pill-optional" id="attachCorrigeBtn" ${busy ? 'disabled' : ''} title="Optional — gives exercises real, checkable answers instead of the usual read-only Verify placeholder">📋 Answer key <span class="opt">optional</span></button>`
                : ''
            }
          </div>
          <input type="file" id="sourceFileInput" multiple class="hide">
          <input type="file" id="corrigeFileInput" accept="${CORRIGE_ACCEPT}" class="hide">
          ${
            showYoutubeInput
              ? `<div class="youtube-input-row">
                   <input type="text" id="youtubeUrlInput" placeholder="https://youtube.com/watch?v=…" value="${esc(youtubeUrl)}">
                   <button type="button" class="btn-sec" id="attachYoutubeBtn">Attach</button>
                 </div>`
              : ''
          }

          ${
            deps.isAdmin
              ? `<label class="checkbox-field composer-advanced">
                   <input type="checkbox" id="forceImageOnlyCheckbox" ${forceImageOnly ? 'checked' : ''}>
                   Force image-only extraction (test mode)
                 </label>`
              : ''
          }

          ${
            extractionMode === 'faithful'
              ? `<div class="composer-info">
                   <strong>What "faithful extraction" means</strong>
                   <p>Use this when your source <em>is</em> the material you want cards from — a textbook page, a worksheet, a set of activities — and you want the cards to mirror it exactly, not be reshaped or summarized by a prompt.</p>
                   <p>Each exercise on the page becomes its own card, reproducing the original wording as written. Cards only get a real front/back/checkable answer if that exercise's answer is present — either printed on the page itself, or supplied separately as an attached answer key ("corrigé", optional above). Otherwise the card is read-only: it shows the exercise but has no answer to check against.</p>
                   <p>If you'd rather describe how the cards should be shaped (e.g. "make vocabulary flashcards from this"), switch to <strong>Generate with a prompt</strong> instead.</p>
                 </div>`
              : `<div class="composer-info">
                   <strong>Writing a good prompt</strong>
                   <p>The more specific you are, the better the cards — a vague prompt like "make flashcards" leaves a lot to guesswork. Consider mentioning:</p>
                   <ul>
                     <li><strong>Roughly how many cards</strong> you want (e.g. "about 15 cards" or "one per vocabulary word")</li>
                     <li><strong>What kind of cards</strong> — plain flashcards, fill-in-the-blank, matching pairs, multiple choice, etc.</li>
                     <li><strong>What each card should include</strong> — an example sentence, IPA/pronunciation, a usage tip, a grammar note</li>
                     <li><strong>The learners' level</strong> — A1, A2, B1, B2… so wording and vocabulary actually match</li>
                     <li><strong>Whether you want a grammar table or rule</strong> laid out explicitly, or just examples in context</li>
                     <li><strong>Which direction to test recall in</strong> — shown French and recall the translation, or the reverse. If you don't say, it defaults to showing the translation and testing recall of the French.</li>
                   </ul>
                 </div>`
          }

          ${
            extractionMode === 'faithful'
              ? `<button type="button" class="btn-primary composer-start-btn" id="composerSendBtn" ${canSend() ? '' : 'disabled'}>${busy ? 'Starting…' : 'Start faithful extraction →'}</button>`
              : ''
          }
        </div>

      <div class="composer-below-options">
        <button class="composer-option-btn" id="chooseJsonBtn"><span class="t">📄 Import from JSON</span></button>
        <button class="composer-option-btn" id="chooseAnkiBtn"><span class="t">🗂️ Import from Anki package</span></button>
      </div>`;
  }

  function wireChooser(): void {
    const textarea = document.getElementById('promptTextarea') as HTMLTextAreaElement | null;
    const sendBtn = document.getElementById('composerSendBtn') as HTMLButtonElement | null;
    const fileInput = document.getElementById('sourceFileInput') as HTMLInputElement | null;
    const corrigeInput = document.getElementById('corrigeFileInput') as HTMLInputElement | null;

    function refreshSendBtn(): void {
      if (sendBtn) sendBtn.disabled = !canSend();
    }

    textarea?.addEventListener('input', () => {
      promptText = textarea.value;
      refreshSendBtn();
    });

    document.querySelectorAll<HTMLButtonElement>('[data-extraction-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.extractionMode as ExtractionMode;
        if (next === extractionMode) return;
        extractionMode = next;
        // Each mode only uses its own extra field — drop the other so no
        // stale hidden state rides along on send.
        if (extractionMode === 'faithful') promptText = '';
        else corrigeFile = null;
        render();
      });
    });

    document.querySelectorAll<HTMLButtonElement>('[data-suggestion]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const suggestion = btn.dataset.suggestion ?? '';
        promptText = promptText.trim() ? `${promptText.trim()} — ${suggestion}` : suggestion;
        render();
      });
    });

    container.querySelectorAll<HTMLButtonElement>('[data-source-kind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pill = SOURCE_PILLS.find((p) => p.kind === btn.dataset.sourceKind);
        if (!pill || !fileInput) return;
        fileInput.accept = pill.accept;
        fileInput.click();
      });
    });
    fileInput?.addEventListener('change', () => {
      const picked = fileInput.files ? Array.from(fileInput.files) : [];
      fileInput.value = '';
      if (!picked.length) return;
      const targetKind = lockedKind() ?? classifyFileKind(picked[0]);
      const matching = picked.filter((f) => classifyFileKind(f) === targetKind);
      const rejected = picked.length - matching.length;
      if (rejected > 0) toast(`Skipped ${rejected} file(s) that weren't ${targetKind} — an import can only contain one source type. Remove the attached files first to switch.`);
      if (!matching.length) return;
      attachedFiles = [...attachedFiles, ...matching];
      youtubeUrl = '';
      showYoutubeInput = false;
      render();
    });
    container.querySelectorAll<HTMLButtonElement>('[data-remove-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.removeFile);
        attachedFiles = attachedFiles.filter((_, idx) => idx !== i);
        render();
      });
    });
    document.getElementById('removeAttachmentBtn')?.addEventListener('click', () => {
      youtubeUrl = '';
      render();
    });
    document.getElementById('youtubePillBtn')?.addEventListener('click', () => {
      showYoutubeInput = !showYoutubeInput;
      render();
    });
    document.getElementById('attachYoutubeBtn')?.addEventListener('click', () => {
      const input = document.getElementById('youtubeUrlInput') as HTMLInputElement | null;
      if (!input?.value.trim()) return;
      youtubeUrl = input.value.trim();
      attachedFiles = [];
      showYoutubeInput = false;
      render();
    });
    document.getElementById('attachCorrigeBtn')?.addEventListener('click', () => corrigeInput?.click());
    corrigeInput?.addEventListener('change', () => {
      const f = corrigeInput.files?.[0];
      corrigeInput.value = '';
      if (!f) return;
      corrigeFile = f;
      render();
    });
    document.getElementById('removeCorrigeBtn')?.addEventListener('click', () => {
      corrigeFile = null;
      render();
    });
    document.getElementById('forceImageOnlyCheckbox')?.addEventListener('change', (e) => {
      forceImageOnly = (e.target as HTMLInputElement).checked;
    });
    sendBtn?.addEventListener('click', () => void handleComposerSend());

    document.getElementById('chooseJsonBtn')?.addEventListener('click', () => {
      mode = 'cards';
      render();
    });
    document.getElementById('chooseAnkiBtn')?.addEventListener('click', () => {
      mode = 'anki';
      render();
    });
  }

  /**
   * Source(s) + prompt (or sources alone) is real, wired to the actual
   * pipeline — the prompt rides along as admin_instructions shaping every
   * page's extraction (see preprocessWorker.ts). A prompt with no source at
   * all is also real (see createPromptOnlyImport/startPromptOnlyImport) —
   * cards generated entirely from the model's own knowledge, grounded by
   * the prompt. A YouTube link is real too, via startYoutubeImport below —
   * only Anki import remains an honest UI-only stub.
   */
  async function handleComposerSend(): Promise<void> {
    if (busy) return;
    if (youtubeUrl.trim()) {
      const prompt = extractionMode === 'prompt' ? promptText.trim() : undefined;
      if (extractionMode === 'prompt' && !prompt) return; // guarded by canSend()/disabled send button already
      await startYoutubeImport(youtubeUrl.trim(), prompt, extractionMode === 'faithful' ? corrigeFile : null);
      return;
    }
    if (!attachedFiles.length) {
      if (extractionMode === 'prompt' && promptText.trim()) await startPromptOnlyImport(promptText.trim());
      return;
    }
    const prompt = extractionMode === 'prompt' ? promptText.trim() : undefined;
    if (extractionMode === 'prompt' && !prompt) return; // guarded by canSend()/disabled send button already
    await startSourceImport(attachedFiles, prompt, extractionMode === 'faithful' ? corrigeFile : null);
  }

  /**
   * A YouTube link: fetch its transcript (fetch-youtube-transcript, backed
   * by transcriptapi.com), wrap it as a synthetic .txt File, then hand off
   * to startSourceImport exactly as if the learner had attached a real text
   * file — same upload/preprocess/extract pipeline, no separate code path.
   * The extra step here is only the transcript fetch itself, which needs
   * its own busy/error handling since it happens before startSourceImport's.
   */
  async function startYoutubeImport(url: string, customPrompt: string | undefined, corrige: File | null): Promise<void> {
    startError = null;
    busy = true;
    render();
    let transcript: string;
    let title: string;
    try {
      const result = await fetchYoutubeTranscript(url);
      transcript = result.transcript;
      title = result.title;
    } catch (e) {
      startError = 'Could not fetch this video’s transcript: ' + errMsg(e);
      busy = false;
      render();
      return;
    }
    const safeTitle = title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, MAX_TITLE_LEN) || 'youtube-transcript';
    const file = new File([transcript], `${safeTitle}.txt`, { type: 'text/plain' });
    await startSourceImport([file], customPrompt, corrige);
  }

  /** No file at all — cards generated purely from the prompt (see createPromptOnlyImport). Skips file upload/preprocessing entirely; the import lands directly in the extraction stage. */
  async function startPromptOnlyImport(prompt: string): Promise<void> {
    startError = null;
    busy = true;
    render();
    const title = deriveImportTitle([], 'prompt', prompt);
    try {
      const imp = await createPromptOnlyImport(deckId, title, prompt);
      deps.onImportCreated(imp.id);
    } catch (e) {
      startError = 'Could not start import: ' + errMsg(e);
      busy = false;
      render();
    }
  }

  async function startSourceImport(files: File[], customPrompt: string | undefined, corrige: File | null): Promise<void> {
    startError = null;
    busy = true;
    render();

    const isImageSource = classifyFileKind(files[0]) === 'image';
    const title = deriveImportTitle(files, extractionMode, customPrompt);

    let importId: string;
    try {
      const imp = await createImport(deckId, title, forceImageOnly, customPrompt, isImageSource);
      importId = imp.id;
    } catch (e) {
      startError = 'Could not start import: ' + errMsg(e);
      busy = false;
      render();
      return;
    }

    const sourceType = IMPORT_SOURCES[0].type;
    for (const file of files) {
      try {
        const rec = await createImportFileRecord(importId, sourceType, file);
        await updateImportFileStatus(rec.id, 'uploading');
        await uploadImportSourceFile(rec.storage_path, file);
        await updateImportFileStatus(rec.id, 'completed');
      } catch (e) {
        const cls = await classifyImportError(e);
        startError = `Could not upload "${file.name}": ${cls.message}`;
        busy = false;
        render();
        return;
      }
    }

    if (corrige) {
      try {
        const rec = await createImportFileRecord(importId, 'corrige', corrige);
        await updateImportFileStatus(rec.id, 'uploading');
        await uploadImportSourceFile(rec.storage_path, corrige);
        await updateImportFileStatus(rec.id, 'completed');
      } catch (e) {
        const cls = await classifyImportError(e);
        startError = `Could not upload the answer key "${corrige.name}": ${cls.message}`;
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

  // ---------- Anki package import (UI only — not wired to a parser yet) ----------

  function renderAnki(): string {
    return `
      <div class="panelbox">
        <h3>Import from Anki package</h3>
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:8px">Upload a <code>.apkg</code> file exported from Anki.</p>
        <div class="filedrop" id="ankiDropZone">Click to choose a .apkg file</div>
        <input type="file" id="ankiFile" accept=".apkg" class="hide">
        <button class="btn-sec" id="backToChooserFromAnkiBtn" style="margin-top:10px">← Choose a different type</button>
      </div>`;
  }

  function wireAnki(): void {
    const fileInput = $<HTMLInputElement>(container, '#ankiFile');
    document.getElementById('ankiDropZone')?.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) toast('Anki package import isn’t wired up yet — coming soon.');
    });
    document.getElementById('backToChooserFromAnkiBtn')?.addEventListener('click', () => {
      mode = 'chooser';
      render();
    });
  }

  // ---------- cards / json flow (unchanged — synchronous, no durability concerns) ----------

  function renderCards(): string {
    return `
      <div class="panelbox">
        <button class="back-link" id="backToChooserFromCardsBtn" style="margin-bottom:10px">← Choose a different type</button>
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
    document.getElementById('backToChooserFromCardsBtn')?.addEventListener('click', () => {
      mode = 'chooser';
      render();
    });
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
