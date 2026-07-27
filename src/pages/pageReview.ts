import type { ImportAudioFile, ImportPage, PageBlock, PageBlockKind, PageExtraction } from '../types';
import { $, errMsg, esc, toast } from '../lib/dom';
import { getImportById, getLatestImportForDeck, listImportAudioFiles, listImportPages } from '../lib/imports';
import {
  approvePageExtraction,
  countBlocksSentToPractice,
  deletePageBlock,
  getCurrentPageExtraction,
  insertPageBlock,
  listPageBlocks,
  reorderPageBlocks,
  requeuePageExtraction,
  sendPageBlocksToPractice,
  updatePageBlock,
} from '../lib/pageExtractions';
import { getRenderedPageUrl, renderPendingPageImages } from '../lib/pageRender';
import { componentTypeLabel, renderBlockContent } from '../lib/blockRenderers';
import { renderReadModeBlock, wireReadModeBlock } from '../lib/readModeRenderers';
import { formatNumberedSourceLines } from '../lib/sourceLines';

type ViewMode = 'read' | 'edit';

const DOCUMENT_TYPES = ['heading', 'paragraph', 'instruction', 'dialogue', 'vocabulary', 'grammar', 'example', 'reference', 'note', 'table', 'caption', 'raw_text'];
const INTERACTION_TYPES = ['multiple_choice', 'fill_blank', 'matching', 'ordering', 'writing', 'speaking', 'listening', 'short_answer'];
const KIND_TYPES: Record<PageBlockKind, string[]> = {
  document: DOCUMENT_TYPES,
  interaction: INTERACTION_TYPES,
  image_ref: ['image_ref'],
  audio_ref: ['audio_ref'],
};

export interface PageReviewDeps {
  onBack: () => void;
  deckId: string;
  deckName: string;
  /** Null means "use the deck's most recent import" — the deck-detail quick-access entry point doesn't know an import id up front. */
  importId: string | null;
}

export async function renderPageReview(container: HTMLElement, deps: PageReviewDeps): Promise<void> {
  let pages: ImportPage[] = [];
  let pageCursor = 0;
  let importTitle = '';
  let importId: string | null = null;
  let noImport = false;
  let extraction: PageExtraction | null = null;
  let blocks: PageBlock[] = [];
  let audioFiles: ImportAudioFile[] = [];
  let renderedImageUrl: string | null = null;
  let zoom = 1;
  let showSourceLines = false;
  let showWarnings = false;
  let editingBlockId: string | null = null;
  let addingBlock = false;
  let sentToPracticeCount = 0;
  let busy = false;
  let viewMode: ViewMode = 'read';
  // Cards for the current page are shown one at a time (not a scrolling
  // list) — the original page image stays fixed on the right the whole
  // time, so there's never a reason to scroll the left panel at all.
  let cardCursor = 0;

  function audioFilesById(): Map<string, ImportAudioFile> {
    return new Map(audioFiles.map((a) => [a.id, a]));
  }

  function currentPage(): ImportPage | null {
    return pages[pageCursor] ?? null;
  }

  async function init(): Promise<void> {
    try {
      importId = deps.importId ?? (await getLatestImportForDeck(deps.deckId))?.id ?? null;
      if (!importId) {
        noImport = true;
        render();
        return;
      }
      const [imp, allPages, audio] = await Promise.all([
        getImportById(importId),
        listImportPages(importId),
        listImportAudioFiles(importId),
      ]);
      importTitle = imp.title;
      pages = allPages;
      audioFiles = audio;
    } catch (e) {
      toast('Could not load import: ' + errMsg(e));
      deps.onBack();
      return;
    }
    if (!pages.length) {
      render();
      return;
    }
    void renderMissingImages(); // background — page rendering needs a real <canvas>, so it can only ever happen client-side
    await loadCurrentPage();
  }

  /** Rasterizes any page that has extracted text but no rendered_page_path yet. Non-blocking: refreshes the current page's image if it just became available. */
  async function renderMissingImages(): Promise<void> {
    if (!importId) return;
    const needsRender = pages.some((p) => (p.extraction_status === 'extracted' || p.extraction_status === 'image_only') && !p.rendered_page_path);
    if (!needsRender) return;
    try {
      await renderPendingPageImages(importId);
      pages = await listImportPages(importId);
      if (!renderedImageUrl) await loadCurrentPage();
    } catch (e) {
      toast('Could not render some page images: ' + errMsg(e));
    }
  }

  async function loadCurrentPage(): Promise<void> {
    const page = currentPage();
    extraction = null;
    blocks = [];
    renderedImageUrl = null;
    zoom = 1;
    cardCursor = 0;
    render();
    if (!page) return;
    try {
      extraction = await getCurrentPageExtraction(page.id);
      blocks = extraction ? await listPageBlocks(extraction.id) : [];
      if (page.rendered_page_path) renderedImageUrl = await getRenderedPageUrl(page.rendered_page_path);
      sentToPracticeCount = blocks.length ? await countBlocksSentToPractice(blocks.map((b) => b.id)) : 0;
    } catch (e) {
      toast('Could not load page: ' + errMsg(e));
    }
    render();
  }

  function goTo(index: number): void {
    if (index < 0 || index >= pages.length || index === pageCursor) return;
    pageCursor = index;
    showSourceLines = false;
    showWarnings = false;
    editingBlockId = null;
    addingBlock = false;
    void loadCurrentPage();
  }

  // ---------- actions ----------

  async function doApprove(): Promise<void> {
    if (!extraction || busy) return;
    const unresolvedCount = extraction.unresolved_warnings?.length ?? 0;
    let force = false;
    let reason: string | undefined;
    if (unresolvedCount > 0) {
      reason = window.prompt(`This page has ${unresolvedCount} unresolved warning(s). Enter a reason to approve anyway (required):`) ?? undefined;
      if (!reason || !reason.trim()) {
        if (reason !== undefined) toast('A reason is required to approve with warnings');
        return; // cancelled, or empty reason
      }
      force = true;
    }
    busy = true;
    render();
    try {
      extraction = await approvePageExtraction(extraction.id, force, reason);
      toast(force ? 'Page approved with warnings overridden' : 'Page approved');
    } catch (e) {
      toast('Could not approve: ' + errMsg(e));
    } finally {
      busy = false;
      render();
    }
  }

  async function doSendToPractice(): Promise<void> {
    const page = currentPage();
    if (!page || busy) return;
    busy = true;
    render();
    try {
      const result = await sendPageBlocksToPractice(page.id, deps.deckId);
      sentToPracticeCount = await countBlocksSentToPractice(blocks.map((b) => b.id));
      toast(result.sent ? `Sent ${result.sent} card(s) to practice.` : 'Already sent — nothing new to add.');
    } catch (e) {
      toast('Could not send to practice: ' + errMsg(e));
    } finally {
      busy = false;
      render();
    }
  }

  async function doReExtract(withInstructions: boolean): Promise<void> {
    const page = currentPage();
    if (!page || busy) return;
    let instructions: string | undefined;
    if (withInstructions) {
      instructions = window.prompt('Admin instructions for re-extraction (what should change?)') ?? undefined;
      if (instructions === undefined) return; // cancelled
    }
    busy = true;
    render();
    if (!importId) return;
    try {
      await requeuePageExtraction(importId, deps.deckId, page.id, instructions);
      toast('Re-extraction queued — run the import pipeline again to process it.');
    } catch (e) {
      toast('Could not queue re-extraction: ' + errMsg(e));
    } finally {
      busy = false;
      render();
    }
  }

  async function doDeleteBlock(blockId: string): Promise<void> {
    if (!window.confirm('Delete this block? This cannot be undone.')) return;
    try {
      await deletePageBlock(blockId);
      blocks = blocks.filter((b) => b.id !== blockId);
      render();
    } catch (e) {
      toast('Could not delete block: ' + errMsg(e));
    }
  }

  async function doMove(blockId: string, direction: -1 | 1): Promise<void> {
    const idx = blocks.findIndex((b) => b.id === blockId);
    const swapWith = idx + direction;
    if (idx < 0 || swapWith < 0 || swapWith >= blocks.length) return;
    const a = blocks[idx];
    const b = blocks[swapWith];
    try {
      await reorderPageBlocks([
        { id: a.id, order_index: b.order_index },
        { id: b.id, order_index: a.order_index },
      ]);
      [blocks[idx], blocks[swapWith]] = [blocks[swapWith], blocks[idx]];
      render();
    } catch (e) {
      toast('Could not reorder: ' + errMsg(e));
    }
  }

  async function saveBlockEdit(blockId: string, form: HTMLFormElement): Promise<void> {
    const kind = $<HTMLSelectElement>(form, '[name=kind]').value as PageBlockKind;
    const componentType = $<HTMLSelectElement>(form, '[name=component_type]').value;
    const sourceText = $<HTMLTextAreaElement>(form, '[name=source_text]').value;
    const contentRaw = $<HTMLTextAreaElement>(form, '[name=content]').value;
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(contentRaw);
    } catch {
      toast('Content is not valid JSON');
      return;
    }
    try {
      const updated = await updatePageBlock(blockId, { kind, component_type: componentType, source_text: sourceText, content, needs_review: true, review_reason: 'manually edited during review' });
      blocks = blocks.map((b) => (b.id === blockId ? updated : b));
      editingBlockId = null;
      render();
    } catch (e) {
      toast('Could not save block: ' + errMsg(e));
    }
  }

  async function saveNewBlock(form: HTMLFormElement): Promise<void> {
    const page = currentPage();
    if (!page || !extraction) return;
    const kind = $<HTMLSelectElement>(form, '[name=kind]').value as PageBlockKind;
    const componentType = $<HTMLSelectElement>(form, '[name=component_type]').value;
    const contentRaw = $<HTMLTextAreaElement>(form, '[name=content]').value;
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(contentRaw);
    } catch {
      toast('Content is not valid JSON');
      return;
    }
    try {
      const inserted = await insertPageBlock({
        page_extraction_id: extraction.id,
        page_id: page.id,
        order_index: blocks.length,
        kind,
        component_type: componentType,
        content,
      });
      blocks = [...blocks, inserted];
      addingBlock = false;
      render();
    } catch (e) {
      toast('Could not add block: ' + errMsg(e));
    }
  }

  async function matchAudioBlock(blockId: string, audioAssetId: string): Promise<void> {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const content = { ...block.content, matchedAudioAssetId: audioAssetId || null, matchConfidence: audioAssetId ? 'high' : null };
    try {
      const updated = await updatePageBlock(blockId, { content, needs_review: !audioAssetId });
      blocks = blocks.map((b) => (b.id === blockId ? updated : b));
      render();
    } catch (e) {
      toast('Could not update audio match: ' + errMsg(e));
    }
  }

  // ---------- render ----------

  function render(): void {
    const body = noImport
      ? '<div class="panelbox">No import yet for this deck — start one from Import content.</div>'
      : pages.length
        ? renderBody()
        : '<div class="panelbox">No pages yet — preprocess the import first.</div>';
    container.innerHTML = `
      <div class="wrap page-review">
        <button class="back-link" id="backBtn">← ${esc(deps.deckName)}</button>
        <div class="page-h"><h1>Review pages</h1><p>${esc(importTitle)}</p></div>
        ${body}
      </div>`;
    $(container, '#backBtn').addEventListener('click', deps.onBack);
    if (pages.length) wireBody();
  }

  function renderBody(): string {
    const page = currentPage();
    if (!page) return '';
    const status = extraction?.status ?? 'pending';
    const unresolvedCount = extraction?.unresolved_warnings?.length ?? 0;
    const canApprove = status === 'needs_review' && !busy;
    const approveLabel = status === 'approved' ? '✓ Approved' : unresolvedCount > 0 ? 'Approve anyway' : 'Approve page';
    const canSendToPractice = status === 'approved' && !busy && blocks.length > 0;
    const allSent = blocks.length > 0 && sentToPracticeCount >= blocks.length;
    const sendToPracticeLabel = allSent ? `✓ Sent to practice (${sentToPracticeCount}/${blocks.length})` : sentToPracticeCount > 0 ? `Send to practice (${sentToPracticeCount}/${blocks.length} sent)` : 'Send to practice';

    return `
      <div class="page-review-toolbar">
        <div class="page-nav">
          <button class="btn-sec" id="prevPageBtn" ${pageCursor === 0 ? 'disabled' : ''}>← Prev</button>
          <span class="page-of">Page ${pageCursor + 1} of ${pages.length}</span>
          <button class="btn-sec" id="nextPageBtn" ${pageCursor === pages.length - 1 ? 'disabled' : ''}>Next →</button>
        </div>
        <span class="page-status-badge ${esc(status)}">${esc(status.replace(/_/g, ' '))}</span>
        ${unresolvedCount > 0 ? `<span class="page-status-badge needs_review">${unresolvedCount} warning(s)</span>` : ''}
        ${extraction?.approved_with_warnings ? `<span class="page-status-badge needs_review" title="${esc(extraction.approval_override_reason ?? '')}">approved with warnings</span>` : ''}
        <div class="page-review-actions">
          <div class="view-mode-toggle">
            <button class="${viewMode === 'read' ? 'on' : ''}" id="readModeBtn">🗂️ Cards</button>
            <button class="${viewMode === 'edit' ? 'on' : ''}" id="editModeBtn">✎ Edit</button>
          </div>
          <button class="btn-sec" id="toggleSourceLinesBtn">${showSourceLines ? '− Hide' : '+ View'} source lines</button>
          <button class="btn-sec" id="toggleWarningsBtn">${showWarnings ? '− Hide' : '+ View'} warnings</button>
          <button class="btn-sec" id="reExtractBtn" ${busy ? 'disabled' : ''}>Re-extract</button>
          <button class="btn-sec" id="reExtractInstructionsBtn" ${busy ? 'disabled' : ''}>Re-extract with instructions</button>
          <button class="btn-primary" id="approveBtn" ${canApprove ? '' : 'disabled'}>${approveLabel}</button>
          <button class="btn-sec" id="sendToPracticeBtn" ${canSendToPractice && !allSent ? '' : 'disabled'} title="${status === 'approved' ? '' : 'Approve the page first'}">${esc(sendToPracticeLabel)}</button>
        </div>
      </div>
      <div class="page-nav-strip">${pages.map((p, i) => `<button class="page-thumb ${i === pageCursor ? 'on' : ''}" data-goto="${i}">${p.displayed_page_number ?? i + 1}</button>`).join('')}</div>
      ${showSourceLines ? renderSourceLinesPanel(page) : ''}
      ${showWarnings ? renderWarningsPanel() : ''}
      <div class="page-review-split">
        <div class="page-review-left ${viewMode === 'read' ? 'page-read-mode' : 'panelbox'}">
          ${viewMode === 'read' ? renderCardStepperPane() : renderEditModePane()}
        </div>
        <div class="page-review-right panelbox">
          <div class="page-zoom-controls">
            <button class="btn-sec" id="zoomOutBtn">−</button>
            <span>${Math.round(zoom * 100)}%</span>
            <button class="btn-sec" id="zoomInBtn">+</button>
          </div>
          <div class="page-image-wrap">
            ${renderedImageUrl ? `<img id="pageImage" src="${esc(renderedImageUrl)}" style="transform:scale(${zoom})" alt="Original page ${pageCursor + 1}">` : '<div class="p-text">Original page image not rendered yet.</div>'}
          </div>
        </div>
      </div>`;
  }

  /**
   * Cards for the current page are shown one at a time, in sequence — never
   * a scrolling list. The original page image stays fixed on the right the
   * whole time, so there's nothing to lose by only showing one card: the
   * learner always has the source page for context, and stepping through
   * cards one by one is the actual reading/learning flow this is for.
   */
  function renderCardStepperPane(): string {
    if (!blocks.length) return '<div class="panelbox"><p class="p-text">No extracted cards yet.</p></div>';
    const clampedCursor = Math.min(cardCursor, blocks.length - 1);
    const block = blocks[clampedCursor];
    const byId = audioFilesById();
    return `
      <div class="card-stepper-nav">
        <button class="btn-sec" id="prevCardBtn" ${clampedCursor === 0 ? 'disabled' : ''}>← Prev</button>
        <span class="card-stepper-of">Card ${clampedCursor + 1} of ${blocks.length}</span>
        <button class="btn-sec" id="nextCardBtn" ${clampedCursor === blocks.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>
      <div class="card-stepper-dots">${blocks.map((_, i) => `<button class="card-stepper-dot ${i === clampedCursor ? 'on' : ''}" data-goto-card="${i}" title="Card ${i + 1}"></button>`).join('')}</div>
      <div class="page-read-content" data-read-block-id="${esc(block.id)}">${renderReadModeBlock(block, byId, true)}</div>`;
  }

  function renderEditModePane(): string {
    return `
      <div class="page-blocks-list">${blocks.map(renderBlockRow).join('') || '<p class="p-text">No extracted blocks yet.</p>'}</div>
      <button class="btn-sec" id="addBlockBtn">+ Add missing block</button>
      ${addingBlock ? renderBlockForm(null) : ''}`;
  }

  function renderSourceLinesPanel(page: ImportPage): string {
    return `<div class="panelbox page-source-lines"><h3>Raw source lines</h3><pre>${esc(formatNumberedSourceLines(page.text ?? ''))}</pre></div>`;
  }

  function renderWarningsPanel(): string {
    if (!extraction) return `<div class="panelbox"><p class="p-text">No extraction yet.</p></div>`;
    const parts: string[] = [];
    if (extraction.model_warnings?.length) {
      parts.push(`<h4>Model warnings</h4><ul>${extraction.model_warnings.map((w) => `<li>${esc(w.code)}: ${esc(w.message)}</li>`).join('')}</ul>`);
    }
    if (extraction.coverage_result) {
      parts.push(`<h4>Deterministic coverage</h4><pre>${esc(JSON.stringify(extraction.coverage_result, null, 2))}</pre>`);
    }
    if (extraction.audit_result) {
      parts.push(`<h4>Completeness audit</h4><pre>${esc(JSON.stringify(extraction.audit_result, null, 2))}</pre>`);
    }
    if (extraction.repair_history?.length) {
      parts.push(`<h4>Repair history</h4><pre>${esc(JSON.stringify(extraction.repair_history, null, 2))}</pre>`);
    }
    parts.push(`<h4>Unresolved warnings (${extraction.unresolved_warnings?.length ?? 0})</h4><pre>${esc(JSON.stringify(extraction.unresolved_warnings ?? [], null, 2))}</pre>`);
    return `<div class="panelbox page-warnings-panel">${parts.join('') || '<p class="p-text">No warnings.</p>'}</div>`;
  }

  function renderBlockRow(block: PageBlock, i: number): string {
    if (editingBlockId === block.id) return renderBlockForm(block);
    const audioControl = block.kind === 'audio_ref' ? renderAudioMatchControl(block) : '';
    return `
      <div class="page-block-row ${block.needs_review ? 'needs-review' : ''}" data-block-id="${esc(block.id)}">
        <div class="page-block-row-h">
          <span class="page-block-kind">${esc(block.kind)} · ${esc(componentTypeLabel(block.component_type))}</span>
          ${block.needs_review ? `<span class="page-status-badge needs_review" title="${esc(block.review_reason ?? '')}">needs review</span>` : ''}
          <div class="page-block-controls">
            <button class="btn-icon" data-move-up="${esc(block.id)}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="btn-icon" data-move-down="${esc(block.id)}" ${i === blocks.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
            <button class="btn-icon" data-edit="${esc(block.id)}" title="Edit">✎</button>
            <button class="btn-icon" data-delete="${esc(block.id)}" title="Delete">🗑</button>
          </div>
        </div>
        ${renderBlockContent(block)}
        ${audioControl}
        ${block.source_line_ids.length ? `<div class="book-src">lines: ${block.source_line_ids.join(', ')}</div>` : ''}
      </div>`;
  }

  function renderAudioMatchControl(block: PageBlock): string {
    const matchedId = (block.content as { matchedAudioAssetId?: string | null }).matchedAudioAssetId ?? '';
    const options = audioFiles
      .map((a) => `<option value="${esc(a.id)}" ${a.id === matchedId ? 'selected' : ''}>${esc(a.original_filename)}${a.track_number != null ? ` (track ${a.track_number})` : ''}</option>`)
      .join('');
    return `<div class="audio-match-control">
      <label>Match to uploaded audio file:</label>
      <select data-audio-match="${esc(block.id)}"><option value="">— none —</option>${options}</select>
    </div>`;
  }

  function renderBlockForm(block: PageBlock | null): string {
    const kind = block?.kind ?? 'document';
    const componentType = block?.component_type ?? DOCUMENT_TYPES[0];
    const kindOptions = (Object.keys(KIND_TYPES) as PageBlockKind[]).map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${k}</option>`).join('');
    const typeOptions = KIND_TYPES[kind as PageBlockKind]
      .map((t) => `<option value="${t}" ${t === componentType ? 'selected' : ''}>${t}</option>`)
      .join('');
    return `
      <form class="page-block-form" data-block-form="${block ? esc(block.id) : 'new'}">
        <div class="field"><label>Kind</label><select name="kind">${kindOptions}</select></div>
        <div class="field"><label>Component type</label><select name="component_type">${typeOptions}</select></div>
        ${block ? `<div class="field"><label>Source text</label><textarea name="source_text" rows="3">${esc(block.source_text)}</textarea></div>` : ''}
        <div class="field"><label>Content (JSON)</label><textarea name="content" rows="6" class="mono">${esc(JSON.stringify(block?.content ?? {}, null, 2))}</textarea></div>
        <div class="row">
          <button type="submit" class="btn-primary">Save</button>
          <button type="button" class="btn-sec" data-cancel-form>Cancel</button>
        </div>
      </form>`;
  }

  function wireBody(): void {
    document.getElementById('prevPageBtn')?.addEventListener('click', () => goTo(pageCursor - 1));
    document.getElementById('nextPageBtn')?.addEventListener('click', () => goTo(pageCursor + 1));
    document.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => goTo(parseInt(btn.dataset.goto!, 10)));
    });
    document.getElementById('readModeBtn')?.addEventListener('click', () => {
      viewMode = 'read';
      render();
    });
    document.getElementById('editModeBtn')?.addEventListener('click', () => {
      viewMode = 'edit';
      render();
    });
    document.getElementById('toggleSourceLinesBtn')?.addEventListener('click', () => {
      showSourceLines = !showSourceLines;
      render();
    });
    document.getElementById('toggleWarningsBtn')?.addEventListener('click', () => {
      showWarnings = !showWarnings;
      render();
    });
    document.getElementById('reExtractBtn')?.addEventListener('click', () => void doReExtract(false));
    document.getElementById('reExtractInstructionsBtn')?.addEventListener('click', () => void doReExtract(true));
    document.getElementById('approveBtn')?.addEventListener('click', () => void doApprove());
    document.getElementById('sendToPracticeBtn')?.addEventListener('click', () => void doSendToPractice());
    document.getElementById('zoomInBtn')?.addEventListener('click', () => {
      zoom = Math.min(3, zoom + 0.25);
      render();
    });
    document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
      zoom = Math.max(0.5, zoom - 0.25);
      render();
    });
    document.getElementById('addBlockBtn')?.addEventListener('click', () => {
      addingBlock = !addingBlock;
      editingBlockId = null;
      render();
    });

    document.querySelectorAll<HTMLButtonElement>('[data-move-up]').forEach((btn) => btn.addEventListener('click', () => void doMove(btn.dataset.moveUp!, -1)));
    document.querySelectorAll<HTMLButtonElement>('[data-move-down]').forEach((btn) => btn.addEventListener('click', () => void doMove(btn.dataset.moveDown!, 1)));
    document.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((btn) => btn.addEventListener('click', () => void doDeleteBlock(btn.dataset.delete!)));
    document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((btn) =>
      btn.addEventListener('click', () => {
        editingBlockId = btn.dataset.edit!;
        addingBlock = false;
        render();
      }),
    );
    document.querySelectorAll<HTMLSelectElement>('[data-audio-match]').forEach((sel) =>
      sel.addEventListener('change', () => void matchAudioBlock(sel.dataset.audioMatch!, sel.value)),
    );

    document.querySelectorAll<HTMLFormElement>('[data-block-form]').forEach((form) => {
      const kindSelect = $<HTMLSelectElement>(form, '[name=kind]');
      kindSelect.addEventListener('change', () => {
        const typeSelect = $<HTMLSelectElement>(form, '[name=component_type]');
        typeSelect.innerHTML = KIND_TYPES[kindSelect.value as PageBlockKind].map((t) => `<option value="${t}">${t}</option>`).join('');
      });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const id = form.dataset.blockForm!;
        if (id === 'new') void saveNewBlock(form);
        else void saveBlockEdit(id, form);
      });
      form.querySelector('[data-cancel-form]')?.addEventListener('click', () => {
        editingBlockId = null;
        addingBlock = false;
        render();
      });
    });

    if (viewMode === 'read') {
      document.getElementById('prevCardBtn')?.addEventListener('click', () => {
        cardCursor = Math.max(0, cardCursor - 1);
        render();
      });
      document.getElementById('nextCardBtn')?.addEventListener('click', () => {
        cardCursor = Math.min(blocks.length - 1, cardCursor + 1);
        render();
      });
      document.querySelectorAll<HTMLButtonElement>('[data-goto-card]').forEach((btn) => {
        btn.addEventListener('click', () => {
          cardCursor = parseInt(btn.dataset.gotoCard!, 10);
          render();
        });
      });
      document.querySelectorAll<HTMLElement>('[data-read-block-id]').forEach((el) => {
        const block = blocks.find((b) => b.id === el.dataset.readBlockId);
        if (block) wireReadModeBlock(block, el);
      });
    }
  }

  render();
  void init();
}
