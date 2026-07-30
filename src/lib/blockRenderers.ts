// Faithful, view-only rendering of a page block's content — reused Book Mode
// visual language (book-doc/book-ref/chat-card/book-select/... classes)
// without the old lesson reader's grading logic, since this pass never
// captures answer keys (grading belongs to a later, card-generation slice).
// Used by the page-review split screen; pageReview.ts wraps whatever this
// renders with the actual review chrome (edit/delete/reorder/approve).

import type {
  CardMatchingContent,
  CardOpenTaskContent,
  CardOrderingContent,
  PageAudioRefContent,
  PageBlock,
  PageDialogueContent,
  PageFillBlankContent,
  PageGrammarContent,
  PageImageRefContent,
  PageMultipleChoiceContent,
  PageTableContent,
  PageTextContent,
  PageVocabularyContent,
} from '../types';
import { esc } from './dom';

function c<T>(block: PageBlock): T {
  return block.content as T;
}

function textBlock(block: PageBlock): string {
  const { text } = c<PageTextContent>(block);
  return `<div class="book-doc"><div class="book-doc-body">${esc(text ?? '')}</div></div>`;
}

function dialogueBlock(block: PageBlock): string {
  const { turns } = c<PageDialogueContent>(block);
  return `<div class="chat-card">${(turns ?? [])
    .map(
      (t, i) =>
        `<div class="chat-bubble ${i % 2 === 0 ? 'left' : 'right'}">${t.speaker ? `<div class="chat-name">${esc(t.speaker)}</div>` : ''}${esc(t.text)}</div>`,
    )
    .join('')}</div>`;
}

function vocabularyBlock(block: PageBlock): string {
  const { pairs } = c<PageVocabularyContent>(block);
  return `<table class="p-tbl">${(pairs ?? [])
    .map((p) => `<tr><td>${esc(p.term)}</td><td>${esc(p.translation ?? '')}</td></tr>`)
    .join('')}</table>`;
}

function grammarBlock(block: PageBlock): string {
  const { text, table } = c<PageGrammarContent>(block);
  const textHtml = text ? `<div class="p-text">${esc(text).replace(/\n/g, '<br>')}</div>` : '';
  const tableHtml = table?.length
    ? `<table class="p-tbl">${table.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`
    : '';
  return `<div class="book-ref">${textHtml}${tableHtml}</div>`;
}

function tableBlock(block: PageBlock): string {
  const { headers, rows } = c<PageTableContent>(block);
  const headHtml = headers?.length ? `<tr>${headers.map((h) => `<td><strong>${esc(h)}</strong></td>`).join('')}</tr>` : '';
  return `<table class="p-tbl">${headHtml}${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
}

function multipleChoiceBlock(block: PageBlock): string {
  const { prompt, options, multi } = c<PageMultipleChoiceContent>(block);
  const opts = (options ?? [])
    .map((o) => `<label class="book-opt"><input type="${multi ? 'checkbox' : 'radio'}" disabled><span>${esc(o)}</span></label>`)
    .join('');
  return `<div class="book-prompt">${esc(prompt ?? '')}</div><div class="book-select">${opts}</div>`;
}

function fillBlankBlock(block: PageBlock): string {
  const { prompt, template } = c<PageFillBlankContent>(block);
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}<div class="book-template">${esc(template ?? '')}</div>`;
}

function matchingBlock(block: PageBlock): string {
  const { prompt, left, right } = c<CardMatchingContent>(block);
  const leftHtml = (left ?? []).map((l) => `<div class="book-match-item">${esc(l)}</div>`).join('');
  const rightHtml = (right ?? []).map((r) => `<div class="book-match-item">${esc(r)}</div>`).join('');
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}<div class="book-match"><div class="book-match-col">${leftHtml}</div><div class="book-match-col">${rightHtml}</div></div>`;
}

function orderingBlock(block: PageBlock): string {
  const { prompt, items } = c<CardOrderingContent>(block);
  const rows = (items ?? []).map((it, i) => `<div class="book-order-row"><span>${i + 1}.</span><span>${esc(it)}</span></div>`).join('');
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}<div class="book-order">${rows}</div>`;
}

function openTaskBlock(block: PageBlock): string {
  const { prompt, note } = c<CardOpenTaskContent>(block);
  return `<div class="book-prompt">${esc(prompt ?? '')}</div>${note ? `<div class="book-note">📌 ${esc(note)}</div>` : ''}`;
}

function imageRefBlock(block: PageBlock): string {
  const { region, caption, parserId } = c<PageImageRefContent>(block);
  return `<div class="book-doc book-image-ref">
    <div class="book-doc-image book-image-placeholder">🖼️ Image${region ? '' : ' (no region detected)'}</div>
    ${caption ? `<div class="p-text">${esc(caption)}</div>` : ''}
    ${parserId ? `<div class="book-src">ref: ${esc(parserId)}</div>` : ''}
  </div>`;
}

function audioRefBlock(block: PageBlock): string {
  const { label, detectedTrackNumber, matchedAudioAssetId } = c<PageAudioRefContent>(block);
  const matchState = matchedAudioAssetId ? 'matched' : 'unmatched';
  return `<div class="book-audio-ref" data-block-id="${esc(block.id)}" data-match-state="${matchState}">
    <span class="chip audio">🔊 ${esc(label)}</span>
    ${detectedTrackNumber ? `<span class="book-src">track ${esc(detectedTrackNumber)}</span>` : ''}
    <span class="audio-match-status ${matchState}">${matchedAudioAssetId ? 'Matched' : 'Unmatched — needs an audio file'}</span>
  </div>`;
}

const DOCUMENT_RENDERERS: Record<string, (b: PageBlock) => string> = {
  heading: textBlock,
  paragraph: textBlock,
  instruction: textBlock,
  example: textBlock,
  note: textBlock,
  caption: textBlock,
  raw_text: textBlock,
  dialogue: dialogueBlock,
  vocabulary: vocabularyBlock,
  grammar: grammarBlock,
  reference: grammarBlock,
  table: tableBlock,
};

const INTERACTION_RENDERERS: Record<string, (b: PageBlock) => string> = {
  multiple_choice: multipleChoiceBlock,
  fill_blank: fillBlankBlock,
  matching: matchingBlock,
  ordering: orderingBlock,
  writing: openTaskBlock,
  speaking: openTaskBlock,
  listening: openTaskBlock,
  short_answer: openTaskBlock,
};

/** Renders one block's content only (no edit chrome) — callers wrap this with review controls. */
export function renderBlockContent(block: PageBlock): string {
  if (block.block_kind === 'image_ref') return imageRefBlock(block);
  if (block.block_kind === 'audio_ref') return audioRefBlock(block);
  const componentType = block.component_type ?? '';
  const renderer = block.block_kind === 'interaction' ? INTERACTION_RENDERERS[componentType] : DOCUMENT_RENDERERS[componentType];
  return renderer ? renderer(block) : textBlock(block);
}

export function componentTypeLabel(componentType: string): string {
  return componentType.replace(/_/g, ' ');
}
