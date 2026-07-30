import type { ImportAudioFile, ImportPage, PageBlock, PageBlockKind, PageExtraction } from '../types';
import { $, confirmDialog, errMsg, esc, toast } from '../lib/dom';
import { getImportById, getLatestImportForDeck, listImportAudioFiles, listImportPages } from '../lib/imports';
import {
  countBlocksSentToPractice,
  deletePageBlock,
  getCurrentPageExtraction,
  insertPageBlock,
  listCardsForSourcePage,
  removePageBlocksFromPractice,
  reorderPageBlocks,
  requeuePageExtraction,
  sendPageBlocksToPractice,
  setCardIncludeInPractice,
  setCardShowSourceInPractice,
  updatePageBlock,
} from '../lib/pageExtractions';
import { getRenderedPageUrl, renderPendingPageImages } from '../lib/pageRender';
import { componentTypeLabel } from '../lib/blockRenderers';
import { renderReadModeBlock, wireReadModeBlock } from '../lib/readModeRenderers';
import { formatNumberedSourceLines } from '../lib/sourceLines';
import { parseContentFields, renderContentFieldsHTML } from '../lib/cardEditorFields';

type ViewMode = 'read' | 'rearrange';

const DOCUMENT_TYPES = ['heading', 'paragraph', 'instruction', 'dialogue', 'vocabulary', 'grammar', 'example', 'reference', 'note', 'table', 'caption', 'raw_text'];
const INTERACTION_TYPES = ['multiple_choice', 'fill_blank', 'matching', 'ordering', 'writing', 'speaking', 'listening', 'short_answer'];
const KIND_TYPES: Record<PageBlockKind, string[]> = {
  document: DOCUMENT_TYPES,
  interaction: INTERACTION_TYPES,
  image_ref: ['image_ref'],
  audio_ref: ['audio_ref'],
};
const CATEGORY_OPTIONS = ['vocabulary', 'grammar', 'culture', 'reading', 'exercise', 'audio', 'writing'];

export interface PageReviewDeps {
  onBack: () => void;
  deckId: string;
  deckName: string;
  /** Null means "use the deck's most recent import" — the deck-detail quick-access entry point doesn't know an import id up front. */
  importId: string | null;
  /** Jumps straight to this page on load (e.g. opened from the Stacks browser) — otherwise starts at page 1. */
  initialPageId?: string;
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
  let showMoreActions = false;
  // Cards for the current page are shown one at a time (not a scrolling
  // list) — the original page image stays fixed on the right the whole
  // time, so there's never a reason to scroll the left panel at all.
  let cardCursor = 0;
  /** For a flashcard-recipe generation-mode card only: lets an admin preview it exactly as Practice mode shows it (interactive flip), instead of the default both-shown read view. Reset whenever the current card changes. */
  let practicePreviewOn = false;
  let practicePreviewFlipped = false;
  let dragBlockId: string | null = null;
  /** Which card's "Ask AI to change this card" box is expanded — at most one at a time. */
  let promptEditOpenFor: string | null = null;

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
      if (deps.initialPageId) {
        const targetIndex = pages.findIndex((p) => p.id === deps.initialPageId);
        if (targetIndex >= 0) pageCursor = targetIndex;
      }
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
      blocks = extraction ? await listCardsForSourcePage(page.id) : [];
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
    promptEditOpenFor = null;
    showMoreActions = false;
    void loadCurrentPage();
  }

  // ---------- actions ----------

  async function doSendToPractice(): Promise<void> {
    const page = currentPage();
    if (!page || busy) return;
    busy = true;
    render();
    try {
      const result = await sendPageBlocksToPractice(page.id);
      blocks = await listCardsForSourcePage(page.id);
      sentToPracticeCount = await countBlocksSentToPractice(blocks.map((b) => b.id));
      toast(result.sent ? `Included ${result.sent} card(s) in practice.` : 'Already included — nothing new to add.');
    } catch (e) {
      toast('Could not update practice inclusion: ' + errMsg(e));
    } finally {
      busy = false;
      render();
    }
  }

  async function doRemoveAllFromPractice(): Promise<void> {
    const page = currentPage();
    if (!page || busy) return;
    busy = true;
    render();
    try {
      const result = await removePageBlocksFromPractice(page.id);
      blocks = await listCardsForSourcePage(page.id);
      sentToPracticeCount = await countBlocksSentToPractice(blocks.map((b) => b.id));
      toast(result.removed ? `Removed ${result.removed} card(s) from practice.` : 'None were in practice.');
    } catch (e) {
      toast('Could not update practice inclusion: ' + errMsg(e));
    } finally {
      busy = false;
      render();
    }
  }

  /** Per-card practice toggle — the primary way to include/exclude a card, independent of page approval status. */
  async function doTogglePractice(blockId: string, checked: boolean): Promise<void> {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    try {
      const updated = await setCardIncludeInPractice(blockId, checked, block.include_in_practice);
      blocks = blocks.map((b) => (b.id === blockId ? updated : b));
      sentToPracticeCount = blocks.filter((b) => b.include_in_practice).length;
      render();
    } catch (e) {
      toast('Could not update practice inclusion: ' + errMsg(e));
    }
  }

  /** Per-card toggle: whether Study/Practice shows this card's source image alongside it. */
  async function doToggleShowSource(blockId: string, checked: boolean): Promise<void> {
    try {
      const updated = await setCardShowSourceInPractice(blockId, checked);
      blocks = blocks.map((b) => (b.id === blockId ? updated : b));
      render();
    } catch (e) {
      toast('Could not update: ' + errMsg(e));
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
    if (!(await confirmDialog('Delete this block? This cannot be undone.'))) return;
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

  /** Drag-and-drop reorder: dropping draggedId onto targetId moves it to that position, then the WHOLE list's order_index is renumbered sequentially (a drag can jump several positions at once, unlike doMove's adjacent swap). Optimistic — resyncs from the server if the write fails. */
  async function doReorderDrag(draggedId: string, targetId: string): Promise<void> {
    const fromIdx = blocks.findIndex((b) => b.id === draggedId);
    const toIdx = blocks.findIndex((b) => b.id === targetId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const reordered = [...blocks];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const previous = blocks;
    blocks = reordered.map((b, i) => ({ ...b, order_index: i }));
    render();
    try {
      await reorderPageBlocks(blocks.map((b, i) => ({ id: b.id, order_index: i })));
    } catch (e) {
      toast('Could not reorder: ' + errMsg(e));
      blocks = previous;
      render();
    }
  }

  /**
   * Saves an edit to an EXISTING card — deliberately never touches
   * kind/component_type (the recipe is fixed once extracted; reshaping a
   * card into a different recipe happens through the prompt-edit box, not
   * this form). Shared fields (title/instruction/translation/category/tags)
   * plus whichever recipe-specific content fields cardEditorFields.ts knows
   * how to render for this block's recipe.
   */
  async function saveCardEditor(blockId: string, form: HTMLFormElement): Promise<void> {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const recipe = block.component_type ?? '';
    const parsed = parseContentFields(recipe, form, (block.content as Record<string, unknown>) ?? {});
    if (!parsed.ok) {
      toast(parsed.error);
      return;
    }
    const title = $<HTMLInputElement>(form, '[name=meta_title]').value.trim() || null;
    const instruction = $<HTMLInputElement>(form, '[name=meta_instruction]').value.trim() || null;
    const translation = $<HTMLTextAreaElement>(form, '[name=meta_translation]').value.trim() || null;
    const tags = $<HTMLInputElement>(form, '[name=meta_tags]').value.split(',').map((s) => s.trim()).filter(Boolean);
    const categoryValue = $<HTMLSelectElement>(form, '[name=meta_category]').value;
    try {
      const updated = await updatePageBlock(blockId, {
        title,
        instruction,
        translation,
        tags,
        category: (categoryValue || null) as PageBlock['category'],
        content: parsed.content,
        needs_review: true,
        review_reason: 'manually edited during review',
      });
      blocks = blocks.map((b) => (b.id === blockId ? updated : b));
      editingBlockId = null;
      promptEditOpenFor = null;
      render();
    } catch (e) {
      toast('Could not save card: ' + errMsg(e));
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
      // Whichever stack this page's existing cards currently live in (its
      // own per-page stack normally, or a shared merged stack if this
      // import was merged) — falls back to the page's own extraction when
      // it has no cards yet at all.
      const stackId = blocks[0]?.stack_id ?? extraction.id;
      const inserted = await insertPageBlock({
        stack_id: stackId,
        page_id: page.id,
        deck_id: deps.deckId,
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
        <button class="back-link" id="backBtn">← Stacks</button>
        <div class="page-h">
          <h1>📘 ${esc(importTitle)}</h1>
          <p>${pages.length > 1 ? `Page ${pageCursor + 1} of ${pages.length}` : 'Page review'}</p>
        </div>
        ${body}
      </div>`;
    $(container, '#backBtn').addEventListener('click', deps.onBack);
    if (pages.length) wireBody();
  }

  function renderBody(): string {
    const page = currentPage();
    if (!page) return '';
    const unresolvedCount = extraction?.unresolved_warnings?.length ?? 0;
    const canSendToPractice = !busy && blocks.length > 0;
    const allSent = blocks.length > 0 && sentToPracticeCount >= blocks.length;
    const canRemoveFromPractice = !busy && sentToPracticeCount > 0;
    const sendToPracticeLabel = allSent
      ? `✓ All in practice (${sentToPracticeCount}/${blocks.length})`
      : sentToPracticeCount > 0
        ? `Include all for practice (${sentToPracticeCount}/${blocks.length} included)`
        : 'Include all for practice';

    return `
      <div class="stack-nav">
        <button class="btn-sec" id="prevPageBtn" ${pageCursor === 0 ? 'disabled' : ''}>← Prev stack</button>
        <div class="stack-nav-strip">${pages.map((p, i) => `<button class="page-thumb ${i === pageCursor ? 'on' : ''}" data-goto="${i}" title="Page ${p.displayed_page_number ?? i + 1}">${p.displayed_page_number ?? i + 1}</button>`).join('')}</div>
        <button class="btn-sec" id="nextPageBtn" ${pageCursor === pages.length - 1 ? 'disabled' : ''}>Next stack →</button>
      </div>
      <div class="page-review-toolbar">
        ${unresolvedCount > 0 ? `<span class="page-status-badge needs_review">${unresolvedCount} warning(s)</span>` : ''}
        <div class="page-review-actions">
          <div class="view-mode-toggle">
            <button class="${viewMode === 'read' ? 'on' : ''}" id="readModeBtn">🗂️ Cards</button>
            <button class="${viewMode === 'rearrange' ? 'on' : ''}" id="rearrangeModeBtn">↕ Rearrange</button>
          </div>
          <button class="btn-sec" id="toggleSourceLinesBtn">${showSourceLines ? '− Hide' : '+ View'} source lines</button>
          <button class="btn-sec" id="toggleWarningsBtn">${showWarnings ? '− Hide' : '+ View'} warnings</button>
          <div class="toolbar-more">
            <button class="btn-sec" id="moreActionsBtn">⋯ More</button>
            ${
              showMoreActions
                ? `<div class="toolbar-more-menu">
                     <button class="btn-sec" id="reExtractBtn" ${busy ? 'disabled' : ''}>Re-extract</button>
                     <button class="btn-sec" id="reExtractInstructionsBtn" ${busy ? 'disabled' : ''}>Re-extract with instructions</button>
                   </div>`
                : ''
            }
          </div>
          <button class="btn-primary" style="width:auto" id="sendToPracticeBtn" ${canSendToPractice && !allSent ? '' : 'disabled'}>${esc(sendToPracticeLabel)}</button>
          <button class="btn-sec" id="removeFromPracticeBtn" ${canRemoveFromPractice ? '' : 'disabled'}>Remove all from practice${sentToPracticeCount > 0 ? ` (${sentToPracticeCount})` : ''}</button>
        </div>
      </div>
      ${showSourceLines ? renderSourceLinesPanel(page) : ''}
      ${showWarnings ? renderWarningsPanel() : ''}
      <div class="page-review-split">
        <div class="page-review-left ${viewMode === 'read' ? 'page-read-mode' : 'panelbox'}">
          ${viewMode === 'read' ? renderCardStepperPane() : renderRearrangePane()}
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
    const nav = `
      <div class="card-stepper-nav">
        <button class="btn-sec" id="prevCardBtn" ${clampedCursor === 0 ? 'disabled' : ''}>← Prev</button>
        <span class="card-stepper-of">Card ${clampedCursor + 1} of ${blocks.length}</span>
        <button class="btn-sec" id="nextCardBtn" ${clampedCursor === blocks.length - 1 ? 'disabled' : ''}>Next →</button>
      </div>
      <div class="card-stepper-dots">${blocks.map((_, i) => `<button class="card-stepper-dot ${i === clampedCursor ? 'on' : ''}" data-goto-card="${i}" title="Card ${i + 1}"></button>`).join('')}</div>`;

    if (editingBlockId === block.id) {
      return `${nav}${renderCardEditor(block)}`;
    }

    const isFlashcardPreviewable = block.component_type === 'flashcard' && block.prompt_generated;

    return `${nav}
      <div class="card-stepper-controls">
        <button class="btn-sec" data-edit="${esc(block.id)}" title="Edit this card">✎ Edit</button>
        <button class="btn-sec" data-delete="${esc(block.id)}" title="Delete this card">🗑 Delete</button>
        ${isFlashcardPreviewable ? `<button class="btn-sec" id="practicePreviewToggle">${practicePreviewOn ? '📄 Show both sides' : '👁 Preview as in Practice'}</button>` : ''}
      </div>
      <div class="card-options-panel">
        <h4>Card options</h4>
        <label class="toggle-row">
          <span>Include in practice</span>
          <span class="toggle-switch"><input type="checkbox" data-toggle-practice="${esc(block.id)}" ${block.include_in_practice ? 'checked' : ''}><span class="toggle-slider"></span></span>
        </label>
        <label class="toggle-row">
          <span>Show source in practice</span>
          <span class="toggle-switch"><input type="checkbox" data-toggle-show-source="${esc(block.id)}" ${block.show_source_in_practice ? 'checked' : ''}><span class="toggle-slider"></span></span>
        </label>
      </div>
      ${
        isFlashcardPreviewable && practicePreviewOn
          ? renderFlashcardPracticePreview(block)
          : `<div class="page-read-content" data-read-block-id="${esc(block.id)}">${renderReadModeBlock(block, byId, true)}</div>`
      }`;
  }

  /** Same flip mechanic as Practice mode (session.ts): tap to reveal the back, nothing more — this is a preview, not a graded review, so there are no FSRS buttons. */
  function renderFlashcardPracticePreview(block: PageBlock): string {
    const content = block.content as { front?: string; back?: string };
    const front = content.front ?? '—';
    const back = content.back ?? '—';
    return `
      <div class="zone" id="practicePreviewZone">
        <div class="card ${practicePreviewFlipped ? 'flipped' : ''}" id="practicePreviewCard">
          <div class="face front"><div class="ctype">Flashcard</div><div class="center"><div class="word">${esc(front)}</div><div class="prompt"><i class="pulse"></i> Tap the card to reveal</div></div></div>
          <div class="face back"><div class="ctype">Flashcard</div><div class="center"><div class="word small">${esc(front)}</div><div class="gloss">${esc(back)}</div></div></div>
        </div>
      </div>`;
  }

  function renderRearrangePane(): string {
    return `
      <div class="page-blocks-list">${blocks.map(renderBlockRow).join('') || '<p class="p-text">No extracted blocks yet.</p>'}</div>
      <button class="btn-sec" id="addBlockBtn">+ Add missing block</button>
      ${addingBlock ? renderNewBlockForm() : ''}`;
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
    if (editingBlockId === block.id) return renderCardEditor(block);
    const audioControl = block.block_kind === 'audio_ref' ? renderAudioMatchControl(block) : '';
    const byId = audioFilesById();
    return `
      <div class="page-block-row ${block.needs_review ? 'needs-review' : ''}" draggable="true" data-block-id="${esc(block.id)}">
        <div class="page-block-row-h">
          <span class="drag-handle" title="Drag to reorder">⠿⠿</span>
          <span class="toggle-switch toggle-switch-sm" title="Include in practice"><input type="checkbox" data-toggle-practice="${esc(block.id)}" ${block.include_in_practice ? 'checked' : ''}><span class="toggle-slider"></span></span>
          <span class="page-block-kind">${esc(block.block_kind ?? '')} · ${esc(componentTypeLabel(block.component_type ?? ''))}</span>
          ${block.needs_review ? `<span class="page-status-badge needs_review" title="${esc(block.review_reason ?? '')}">needs review</span>` : ''}
          <div class="page-block-controls">
            <button class="btn-icon" data-move-up="${esc(block.id)}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="btn-icon" data-move-down="${esc(block.id)}" ${i === blocks.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
            <button class="btn-icon" data-edit="${esc(block.id)}" title="Edit">✎</button>
            <button class="btn-icon" data-delete="${esc(block.id)}" title="Delete">🗑</button>
          </div>
        </div>
        <div class="page-read-content" data-read-block-id="${esc(block.id)}">${renderReadModeBlock(block, byId, false)}</div>
        ${audioControl}
        ${block.source_line_ids?.length ? `<div class="book-src">lines: ${block.source_line_ids.join(', ')}</div>` : ''}
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

  /**
   * The manual card editor — recipe-aware but recipe-FIXED (no kind/
   * component_type control here): shared fields every card has, plus
   * whichever plain-language content fields fit this card's current
   * recipe. Reshaping a card into a different recipe is a job for the
   * prompt-edit box below, not this form.
   */
  function renderCardEditor(block: PageBlock): string {
    const recipe = block.component_type ?? '';
    const categoryOptions = CATEGORY_OPTIONS.map((c) => `<option value="${c}" ${block.category === c ? 'selected' : ''}>${c}</option>`).join('');
    const promptEditOpen = promptEditOpenFor === block.id;
    return `
      <form class="card-editor" data-card-editor="${esc(block.id)}">
        <div class="field"><label>Title (optional)</label><input name="meta_title" value="${esc(block.title ?? '')}"></div>
        <div class="field"><label>Instruction (optional)</label><input name="meta_instruction" value="${esc(block.instruction ?? '')}"></div>
        <hr class="card-editor-divider">
        ${renderContentFieldsHTML(recipe, (block.content as Record<string, unknown>) ?? {})}
        <hr class="card-editor-divider">
        <div class="field"><label>Translation</label><textarea name="meta_translation" rows="2">${esc(block.translation ?? '')}</textarea></div>
        <div class="field"><label>Category</label><select name="meta_category"><option value="">— none —</option>${categoryOptions}</select></div>
        <div class="field"><label>Tags <span class="field-hint">— comma separated</span></label><input name="meta_tags" value="${esc((block.tags ?? []).join(', '))}"></div>

        <div class="prompt-edit">
          <button type="button" class="btn-sec" data-prompt-edit-toggle="${esc(block.id)}">✨ Ask AI to change this card</button>
          ${
            promptEditOpen
              ? `<div class="prompt-edit-box">
                   <textarea rows="3" placeholder="Describe what you want changed — e.g. “turn this into a fill-in-the-blank” or “make the translation more natural”"></textarea>
                   <button type="button" class="btn-primary" style="width:auto" data-prompt-edit-submit="${esc(block.id)}">Submit</button>
                 </div>`
              : ''
          }
        </div>

        <div class="row">
          <button type="submit" class="btn-primary" style="width:auto">Save</button>
          <button type="button" class="btn-sec" data-cancel-form>Cancel</button>
        </div>
      </form>`;
  }

  /** Raw kind/component_type/JSON form — only ever used for adding a brand-new block from scratch, where there's no existing recipe to preserve. */
  function renderNewBlockForm(): string {
    const kind: PageBlockKind = 'document';
    const componentType = DOCUMENT_TYPES[0];
    const kindOptions = (Object.keys(KIND_TYPES) as PageBlockKind[]).map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${k}</option>`).join('');
    const typeOptions = KIND_TYPES[kind].map((t) => `<option value="${t}" ${t === componentType ? 'selected' : ''}>${t}</option>`).join('');
    return `
      <form class="page-block-form" data-new-block-form>
        <div class="field"><label>Kind</label><select name="kind">${kindOptions}</select></div>
        <div class="field"><label>Component type</label><select name="component_type">${typeOptions}</select></div>
        <div class="field"><label>Content (JSON)</label><textarea name="content" rows="6" class="mono">{}</textarea></div>
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
    document.getElementById('rearrangeModeBtn')?.addEventListener('click', () => {
      viewMode = 'rearrange';
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
    document.getElementById('moreActionsBtn')?.addEventListener('click', () => {
      showMoreActions = !showMoreActions;
      render();
    });
    document.getElementById('reExtractBtn')?.addEventListener('click', () => void doReExtract(false));
    document.getElementById('reExtractInstructionsBtn')?.addEventListener('click', () => void doReExtract(true));
    document.getElementById('sendToPracticeBtn')?.addEventListener('click', () => void doSendToPractice());
    document.getElementById('removeFromPracticeBtn')?.addEventListener('click', () => void doRemoveAllFromPractice());
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
        promptEditOpenFor = null;
        render();
      }),
    );
    document.querySelectorAll<HTMLSelectElement>('[data-audio-match]').forEach((sel) =>
      sel.addEventListener('change', () => void matchAudioBlock(sel.dataset.audioMatch!, sel.value)),
    );
    document.querySelectorAll<HTMLInputElement>('[data-toggle-practice]').forEach((cb) =>
      cb.addEventListener('change', () => void doTogglePractice(cb.dataset.togglePractice!, cb.checked)),
    );
    document.querySelectorAll<HTMLInputElement>('[data-toggle-show-source]').forEach((cb) =>
      cb.addEventListener('change', () => void doToggleShowSource(cb.dataset.toggleShowSource!, cb.checked)),
    );

    // The "add a brand-new block" form (raw kind/type/JSON — see
    // renderNewBlockForm) — always exactly zero or one instance.
    const newBlockForm = document.querySelector<HTMLFormElement>('[data-new-block-form]');
    if (newBlockForm) {
      const kindSelect = $<HTMLSelectElement>(newBlockForm, '[name=kind]');
      kindSelect.addEventListener('change', () => {
        const typeSelect = $<HTMLSelectElement>(newBlockForm, '[name=component_type]');
        typeSelect.innerHTML = KIND_TYPES[kindSelect.value as PageBlockKind].map((t) => `<option value="${t}">${t}</option>`).join('');
      });
      newBlockForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        void saveNewBlock(newBlockForm);
      });
      newBlockForm.querySelector('[data-cancel-form]')?.addEventListener('click', () => {
        addingBlock = false;
        render();
      });
    }

    // The recipe-aware editor for an existing card (see renderCardEditor).
    document.querySelectorAll<HTMLFormElement>('[data-card-editor]').forEach((form) => {
      const blockId = form.dataset.cardEditor!;
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        void saveCardEditor(blockId, form);
      });
      form.querySelector('[data-cancel-form]')?.addEventListener('click', () => {
        editingBlockId = null;
        promptEditOpenFor = null;
        render();
      });
    });
    document.querySelectorAll<HTMLButtonElement>('[data-prompt-edit-toggle]').forEach((btn) =>
      btn.addEventListener('click', () => {
        promptEditOpenFor = promptEditOpenFor === btn.dataset.promptEditToggle ? null : (btn.dataset.promptEditToggle ?? null);
        render();
      }),
    );
    document.querySelectorAll<HTMLButtonElement>('[data-prompt-edit-submit]').forEach((btn) =>
      btn.addEventListener('click', () => {
        toast('Coming soon — AI-assisted card editing isn’t wired up yet.');
      }),
    );

    if (viewMode === 'read') {
      document.getElementById('prevCardBtn')?.addEventListener('click', () => {
        cardCursor = Math.max(0, cardCursor - 1);
        practicePreviewOn = false;
        practicePreviewFlipped = false;
        render();
      });
      document.getElementById('nextCardBtn')?.addEventListener('click', () => {
        cardCursor = Math.min(blocks.length - 1, cardCursor + 1);
        practicePreviewOn = false;
        practicePreviewFlipped = false;
        render();
      });
      document.querySelectorAll<HTMLButtonElement>('[data-goto-card]').forEach((btn) => {
        btn.addEventListener('click', () => {
          cardCursor = parseInt(btn.dataset.gotoCard!, 10);
          practicePreviewOn = false;
          practicePreviewFlipped = false;
          render();
        });
      });
      document.getElementById('practicePreviewToggle')?.addEventListener('click', () => {
        practicePreviewOn = !practicePreviewOn;
        practicePreviewFlipped = false;
        render();
      });
      document.getElementById('practicePreviewCard')?.addEventListener('click', () => {
        practicePreviewFlipped = !practicePreviewFlipped;
        render();
      });
    }

    // Cards render through the same read-mode component whether shown one
    // at a time (Cards view) or as a compact rearrange list — wire both
    // the same way, regardless of which pane is currently active.
    document.querySelectorAll<HTMLElement>('[data-read-block-id]').forEach((el) => {
      const block = blocks.find((b) => b.id === el.dataset.readBlockId);
      if (block) wireReadModeBlock(block, el);
    });

    if (viewMode === 'rearrange') wireDragAndDrop();
  }

  function wireDragAndDrop(): void {
    document.querySelectorAll<HTMLElement>('.page-block-row[draggable]').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        dragBlockId = row.dataset.blockId ?? null;
        row.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', dragBlockId ?? '');
        }
      });
      row.addEventListener('dragend', () => {
        dragBlockId = null;
        document.querySelectorAll('.page-block-row').forEach((r) => r.classList.remove('dragging', 'drag-over'));
      });
      row.addEventListener('dragover', (e) => {
        if (!dragBlockId || row.dataset.blockId === dragBlockId) return;
        e.preventDefault();
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const targetId = row.dataset.blockId;
        if (!dragBlockId || !targetId || dragBlockId === targetId) return;
        void doReorderDrag(dragBlockId, targetId);
      });
    });
  }

  render();
  void init();
}
