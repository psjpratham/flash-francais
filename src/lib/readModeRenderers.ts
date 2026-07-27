// Polished Read Mode rendering for the page-review split screen (LEFT panel
// only — the RIGHT panel keeps showing the original PDF page image, and
// nothing here ever crops/recreates textbook images: image_ref blocks get a
// minimal inline text reference, not an image box).
//
// Content model: a small, deliberately generic set of card "recipes" (see
// CardRecipe in ../types) rather than a large taxonomy of textbook
// phrasings — 'text' covers every kind of reading content (headings,
// passages, instructions, notes, examples, grammar), 'text_input' covers
// every kind of answer-slot (single field, several labeled fields, or
// inline blanks in a template), and so on. 'freeform' is the escape hatch
// for genuinely novel layouts (family trees, embedded webpage mockups) that
// don't fit any recipe — a small allowlisted primitive tree, never raw
// HTML. Every renderer below is tolerant of the closest pre-recipe legacy
// shape too, via resolveReadModeComponentType (legacyComponentMap.ts) and
// defensive content reads — old rows are never migrated or rewritten.
//
// Deliberately NOT graded: no answer keys are captured by extraction, so
// "Verify" (answer_key_status) and "activity audio" (activity_audio_reference)
// are purely visual provisioning here. The existing, already-functional
// audio_ref matching/playback system is untouched.

import type {
  ActivityAudioReference,
  AnswerKeyStatus,
  CardCategorizeContent,
  CardChoiceContent,
  CardGrammarRuleContent,
  CardMatchingContent,
  CardOpenTaskContent,
  CardOrderingContent,
  CardTableContent,
  CardTextContent,
  CardTextInputContent,
  CardVocabularyContent,
  ImportAudioFile,
  PageBlock,
  RichTextContent,
} from '../types';
import { esc, toast } from './dom';
import { getImportAudioUrl } from './imports';
import { resolveReadModeComponentType } from './legacyComponentMap';
import { renderComposedActivity } from './composedActivity';
import { renderRichText, renderRichTextPronounced, renderTextWithPronunciation } from './richText';

function c<T>(block: PageBlock): T {
  return block.content as T;
}

// ---------- the standard learning-section card wrapper (spec section 1) ----------

/** A small, closed icon set for CardCategory — entirely our own CSS/markup, never model-authored styling (see CardCategory in ../types for why). */
const CATEGORY_ICON: Record<string, string> = {
  vocabulary: '🔤',
  grammar: '📐',
  culture: '🌍',
  reading: '📖',
  exercise: '✏️',
  audio: '🎧',
  writing: '✍️',
};

function normalizeForDedup(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A heading-style 'text' card, or an image_ref/audio_ref card whose caption/
 * label repeats the title verbatim, doesn't need the title shown twice —
 * the body already says it. This is a deterministic, guaranteed fix for the
 * most common duplicate-title case; it does not (and can't, generically)
 * catch every way a model might restate a label across title/instruction/
 * content — that broader "don't repeat yourself across fields" judgment
 * call is the extraction polish pass's job, not the renderer's.
 */
function isTitleRedundant(block: PageBlock, recipe: string): boolean {
  if (!block.title) return false;
  const titleNorm = normalizeForDedup(block.title);
  if (recipe === 'text') {
    const content = block.content as CardTextContent;
    if (content.style === 'heading') {
      const bodyText = Array.isArray(content.nodes) ? content.nodes.map((n) => n.spans.map((s) => s.text).join('')).join(' ') : (content.text ?? '');
      return normalizeForDedup(bodyText) === titleNorm;
    }
  }
  if (block.kind === 'image_ref') {
    const caption = (block.content as { caption?: string })?.caption;
    return !!caption && normalizeForDedup(caption) === titleNorm;
  }
  if (block.kind === 'audio_ref') {
    const label = (block.content as { label?: string })?.label;
    return !!label && normalizeForDedup(label) === titleNorm;
  }
  return false;
}

/** Best-effort plain-text summary of a card's own content — used only to detect (and suppress) an instruction/title that just repeats it, never for anything else. */
function getPrimaryBodyText(block: PageBlock, recipe: string): string | null {
  const content = block.content as Record<string, unknown>;
  switch (recipe) {
    case 'text': {
      const c = content as CardTextContent;
      if (Array.isArray(c.nodes) && c.nodes.length) return c.nodes[0].spans.map((s) => s.text).join('');
      return c.text ?? null;
    }
    case 'grammar_rule':
      return (content as CardGrammarRuleContent).rule ?? null;
    case 'vocabulary':
      return (content as CardVocabularyContent).title ?? null;
    case 'single_choice':
    case 'multi_select':
      return (content as CardChoiceContent).prompt ?? null;
    case 'text_input':
      return (content as CardTextInputContent).prompt ?? null;
    case 'matching_pairs':
      return (content as CardMatchingContent).prompt ?? null;
    case 'ordering':
      return (content as CardOrderingContent).prompt ?? null;
    case 'categorize':
      return (content as CardCategorizeContent).prompt ?? null;
    case 'speaking':
    case 'listening':
      return (content as CardOpenTaskContent).prompt ?? null;
    default:
      return null;
  }
}

/**
 * The model was explicitly told (both in the main prompt and the dedicated
 * polish pass) never to repeat a label across title/instruction/content —
 * verified against real output that it still does this often (e.g. a
 * grammar_rule card with instruction and content.rule both "La négation (1)
 * ne... pas"). Rather than keep hoping a bigger prompt fixes something this
 * mechanical, this is a deterministic backstop: suppress the instruction
 * banner whenever it just restates the title or the card's own primary
 * content, guaranteed, independent of model compliance.
 */
function isInstructionRedundant(block: PageBlock, recipe: string): boolean {
  if (!block.instruction) return false;
  const instructionNorm = normalizeForDedup(block.instruction);
  if (block.title && normalizeForDedup(block.title) === instructionNorm) return true;
  const bodyText = getPrimaryBodyText(block, recipe);
  return !!bodyText && normalizeForDedup(bodyText) === instructionNorm;
}

function renderCardHeader(block: PageBlock, showNumBadge: boolean, suppressTitle: boolean): string {
  // Sibling cards split out of the same exercise (e.g. one card per
  // sub-question) legitimately share one section_number — showing that
  // number's badge on every single one of them reads as "1, 1, 1..."
  // repeated rather than "exercise 1, with several parts". Only the first
  // card of a run with the same section_number shows the badge.
  const numBadge = block.section_number && showNumBadge ? `<span class="read-card-num">${esc(block.section_number)}</span>` : '';
  const icon = block.category && CATEGORY_ICON[block.category] ? `<span class="read-card-icon">${CATEGORY_ICON[block.category]}</span>` : '';
  const title = block.title && !suppressTitle ? `<h3 class="read-card-title">${esc(block.title)}</h3>` : '';
  const flag = block.needs_review ? `<span class="read-card-flag" title="${esc(block.review_reason ?? '')}">needs review</span>` : '';
  if (!numBadge && !icon && !title && !flag) return '';
  return `<div class="read-card-head">${numBadge}${icon}${title}<span class="read-card-head-spacer"></span>${flag}</div>`;
}

function renderCardInstruction(block: PageBlock, suppress: boolean): string {
  if (!block.instruction || suppress) return '';
  return `<div class="read-card-instruction">${esc(block.instruction)}</div>`;
}

/** Visual-only "Verify" provisioning (spec section 8) — no grading logic. Status drives whether the button is enabled, never whether an answer is checked. */
function renderVerifyArea(block: PageBlock): string {
  if (block.kind !== 'interaction') return '';
  const status: AnswerKeyStatus = block.answer_key_status ?? 'unknown';
  const cfg: Record<AnswerKeyStatus, { label: string; disabled: boolean; note: string }> = {
    available: { label: 'Verify', disabled: false, note: '' },
    unavailable: { label: 'Verify — unavailable', disabled: true, note: 'No answer key available for this exercise yet.' },
    unknown: { label: 'Verify — pending', disabled: true, note: 'Answer key status not yet determined.' },
  };
  const s = cfg[status];
  return `<div class="read-verify-area">
    <button type="button" class="btn-sec read-verify-btn" data-verify-block="${esc(block.id)}" ${s.disabled ? 'disabled' : ''}>${esc(s.label)}</button>
    ${s.note ? `<span class="read-verify-note">${esc(s.note)}</span>` : ''}
    <div class="read-feedback-area" data-feedback-area="${esc(block.id)}" hidden></div>
  </div>`;
}

/** A card-level toggle revealing a full English translation — generated separately from source_text, never a substitute for the original French wording. Absent entirely when no translation was produced (e.g. legacy rows). */
function renderTranslationToggle(block: PageBlock): string {
  if (!block.translation) return '';
  return `<div class="read-translation">
    <button type="button" class="read-translation-toggle" data-translate-toggle="${esc(block.id)}" aria-expanded="false">🌐 Show English</button>
    <div class="read-translation-text" data-translate-text="${esc(block.id)}" hidden>${esc(block.translation)}</div>
  </div>`;
}

function renderCard(block: PageBlock, bodyHtml: string, showNumBadge: boolean, recipe: string): string {
  const categoryAttr = block.category ? ` data-category="${esc(block.category)}"` : '';
  return `<div class="read-card" data-kind="${esc(block.kind)}"${categoryAttr}>
    ${renderCardHeader(block, showNumBadge, isTitleRedundant(block, recipe))}
    ${renderCardInstruction(block, isInstructionRedundant(block, recipe))}
    <div class="read-card-body">${bodyHtml}</div>
    ${renderTranslationToggle(block)}
    ${renderVerifyArea(block)}
  </div>`;
}

// ---------- purely-visual activity audio area (spec section 9B) ----------
// Distinct from the pronunciation icon (9A) and from the existing, untouched
// audio_ref matching system — never wired to real playback/matching here.

function renderActivityAudioArea(ref: ActivityAudioReference): string {
  if (!ref) return '';
  const icon = ref.status === 'matched' ? '🎧' : ref.status === 'unresolved' ? '🔈' : '🔇';
  const label = ref.status === 'matched' ? 'Audio ready' : ref.status === 'unresolved' ? 'Audio not yet matched' : 'No audio available';
  return `<div class="read-activity-audio ${esc(ref.status)}">
    <span class="read-activity-audio-icon">${icon}</span>
    <span class="read-activity-audio-label">${esc(ref.label)}</span>
    <span class="read-activity-audio-status">${esc(label)}</span>
  </div>`;
}

// ---------- inline blank templates (first-class text entry, not a fallback) ----------

/** Inline blank markers (____ / (...) / []) become real inputs. Applied to already-esc()'d text, so it's safe to regex-replace with our own constructed markup. */
function renderInlineTemplate(escapedTemplate: string, inputPrefix: string): string {
  let idx = 0;
  return escapedTemplate.replace(/_{3,}|\(\s*\.\.\.\s*\)|\[\s*\]/g, () => {
    const input = `<input type="text" class="read-inline-blank" data-blank-input="${esc(inputPrefix)}-${idx}" placeholder="…">`;
    idx++;
    return input;
  });
}

const INLINE_BLANK_RE = /_{3,}|\(\s*\.\.\.\s*\)|\[\s*\]/;

// ---------- 'text' recipe: every kind of reading content ----------

/** A block's own raw (possibly-legacy) component_type carries a soft style hint even though it no longer determines the recipe — a heading/instruction/example/note/passage still looks the part. */
function legacyTextStyle(componentType: string): CardTextContent['style'] {
  if (componentType === 'page_heading' || componentType === 'section_heading' || componentType === 'heading') return 'heading';
  if (componentType === 'instruction') return 'instruction';
  if (componentType === 'example') return 'example';
  if (componentType === 'note') return 'note';
  if (componentType === 'reading_passage') return 'passage';
  return null;
}

const STYLE_CLASS: Record<string, string> = {
  instruction: 'read-instruction',
  example: 'read-example',
  note: 'read-note',
  passage: 'read-passage',
};

function renderAdjunctTable(table: string[][] | undefined): string {
  if (!table?.length) return '';
  return `<table class="p-tbl">${table.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
}

function textBody(block: PageBlock): string {
  const content = block.content as CardTextContent;
  const style = content.style ?? legacyTextStyle(block.component_type);
  const pron = block.pronunciation_enabled;

  let bodyHtml: string;
  if (Array.isArray(content.nodes) && content.nodes.length) {
    const rich: RichTextContent = { nodes: content.nodes };
    bodyHtml = pron ? renderRichTextPronounced(rich, true) : renderRichText(rich);
  } else if (style === 'heading') {
    bodyHtml = `<div class="read-heading">${esc(content.text ?? '')}</div>`;
  } else {
    bodyHtml = renderTextWithPronunciation(content.text ?? '', pron);
  }

  const styleClass = style ? (STYLE_CLASS[style] ?? '') : '';
  return `<div class="read-text ${styleClass}">${bodyHtml}</div>${renderAdjunctTable(content.table)}`;
}

// ---------- 'vocabulary' recipe: a themed group of terms, purpose-built (not a flat table) ----------

function vocabularyBody(block: PageBlock): string {
  const { title, pairs } = c<CardVocabularyContent>(block);
  const pron = block.pronunciation_enabled;
  const rows = (pairs ?? [])
    .map(
      (p) => `<div class="read-vocab-entry">
        <div class="read-vocab-term-row">
          <span class="read-vocab-term">${esc(p.term)}</span>
          ${pron ? '<button type="button" class="pron-icon" data-pron-play title="Play pronunciation">🔊</button>' : ''}
          ${p.translation ? `<span class="read-vocab-translation">${esc(p.translation)}</span>` : ''}
        </div>
        ${p.example ? `<div class="read-vocab-example">${esc(p.example)}</div>` : ''}
      </div>`,
    )
    .join('');
  return `${title ? `<div class="read-vocab-title">${esc(title)}</div>` : ''}<div class="read-vocab-group">${rows}</div>`;
}

// ---------- 'grammar_rule' recipe: one rule + examples, purpose-built (not a generic paragraph) ----------

function grammarRuleBody(block: PageBlock): string {
  const { rule, examples } = c<CardGrammarRuleContent>(block);
  const examplesHtml = examples?.length ? `<div class="read-grammar-examples">${examples.map((ex) => `<div class="read-grammar-example">${esc(ex)}</div>`).join('')}</div>` : '';
  return `<div class="read-grammar-rule">${esc(rule ?? '')}</div>${examplesHtml}`;
}

// ---------- 'table' recipe ----------

function tableBody(block: PageBlock): string {
  const content = block.content as CardTableContent;
  if (content.pairs?.length) {
    const pron = block.pronunciation_enabled;
    return `<table class="p-tbl read-vocab-table">${content.pairs
      .map(
        (p) =>
          `<tr><td class="read-vocab-term">${esc(p.term)}${pron ? ' <button type="button" class="pron-icon" data-pron-play title="Play pronunciation">🔊</button>' : ''}</td><td>${esc(p.translation ?? '')}</td></tr>`,
      )
      .join('')}</table>`;
  }
  const headHtml = content.headers?.length ? `<tr>${content.headers.map((h) => `<td><strong>${esc(h)}</strong></td>`).join('')}</tr>` : '';
  return `<table class="p-tbl">${headHtml}${(content.rows ?? []).map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
}

// ---------- 'dialogue' recipe (reading, or fill-in-the-blank when interactive) ----------

function dialogueBody(block: PageBlock): string {
  const { turns } = c<{ turns: { speaker: string | null; text?: string; template?: string }[] }>(block);
  const pron = block.pronunciation_enabled;
  const isInteraction = block.kind === 'interaction';
  return `<div class="chat-card">${(turns ?? [])
    .map((t, i) => {
      const text = t.text ?? t.template ?? '';
      const hasBlank = isInteraction && INLINE_BLANK_RE.test(text);
      const bodyHtml = hasBlank
        ? renderInlineTemplate(esc(text), `${block.id}-${i}`)
        : pron
          ? renderTextWithPronunciation(text, true)
          : `<span>${esc(text)}</span>`;
      return `<div class="chat-bubble ${i % 2 === 0 ? 'left' : 'right'}">${t.speaker ? `<div class="chat-name">${esc(t.speaker)}</div>` : ''}${bodyHtml}</div>`;
    })
    .join('')}</div>`;
}

// ---------- choice recipes ----------

function singleChoiceBody(block: PageBlock): string {
  const { prompt, options } = c<CardChoiceContent>(block);
  const name = `read-sc-${block.id}`;
  const opts = (options ?? [])
    .map(
      (o, i) =>
        `<button type="button" class="read-choice-opt" role="radio" aria-checked="false" data-choice-value="${esc(o)}" id="${esc(name)}-${i}"><span class="read-choice-mark read-choice-mark-radio"></span><span class="read-choice-label">${esc(o)}</span></button>`,
    )
    .join('');
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}<div class="read-choice-list" data-choice-single="${esc(block.id)}">${opts}</div>`;
}

function multiSelectBody(block: PageBlock): string {
  const { prompt, options } = c<CardChoiceContent>(block);
  const name = `read-ms-${block.id}`;
  const opts = (options ?? [])
    .map(
      (o, i) =>
        `<button type="button" class="read-choice-opt" role="checkbox" aria-checked="false" data-choice-value="${esc(o)}" id="${esc(name)}-${i}"><span class="read-choice-mark read-choice-mark-check"></span><span class="read-choice-label">${esc(o)}</span></button>`,
    )
    .join('');
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}<div class="read-choice-list" data-choice-multi="${esc(block.id)}">${opts}</div>`;
}

// ---------- 'text_input' recipe: one field, several fields, or inline blanks ----------

function isLegacyLongForm(componentType: string): boolean {
  return componentType === 'writing' || componentType === 'long_writing';
}

function textInputBody(block: PageBlock): string {
  const content = block.content as CardTextInputContent & { note?: string | null };
  const promptHtml = content.prompt ? `<div class="book-prompt">${esc(content.prompt)}</div>` : '';
  const noteHtml = content.note ? `<div class="book-note">📌 ${esc(content.note)}</div>` : '';

  if (content.template) {
    return `${promptHtml}<div class="read-fillblank-line">${renderInlineTemplate(esc(content.template), block.id)}</div>`;
  }
  if (content.fields?.length) {
    const rows = content.fields
      .map(
        (f) => `<div class="read-mte-row">
      ${f.label ? `<span class="read-mte-label">${esc(f.label)}</span>` : ''}
      ${f.prefix ? `<span class="read-mte-affix">${esc(f.prefix)}</span>` : ''}
      <input type="text" class="read-mte-input" data-mte-field="${esc(block.id)}-${esc(f.id)}" placeholder="${esc(f.placeholder ?? '')}">
      ${f.suffix ? `<span class="read-mte-affix">${esc(f.suffix)}</span>` : ''}
    </div>`,
      )
      .join('');
    return `${promptHtml}<div class="read-mte-fields">${rows}</div>`;
  }
  const isLong = content.long === true || isLegacyLongForm(block.component_type);
  if (isLong) {
    return `${promptHtml}${noteHtml}<textarea class="read-long-writing" rows="6" data-long-writing="${esc(block.id)}" placeholder="${esc(content.placeholder ?? 'Écrivez votre réponse ici…')}"></textarea>`;
  }
  return `${promptHtml}${noteHtml}<input type="text" class="read-text-entry" data-text-entry="${esc(block.id)}" placeholder="${esc(content.placeholder ?? 'Votre réponse…')}">`;
}

// ---------- 'matching_pairs' recipe (redesigned per spec section 5) ----------

function matchingBody(block: PageBlock): string {
  const { prompt, left, right } = c<CardMatchingContent>(block);
  const leftHtml = (left ?? [])
    .map((l, i) => `<button type="button" class="read-match-item" data-side="left" data-idx="${i}">${esc(l)}</button>`)
    .join('');
  const rightHtml = (right ?? [])
    .map((r, i) => `<button type="button" class="read-match-item" data-side="right" data-idx="${i}">${esc(r)}</button>`)
    .join('');
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}
    <div class="read-match" data-match-root="${esc(block.id)}">
      <div class="read-match-col">${leftHtml}</div>
      <div class="read-match-col">${rightHtml}</div>
    </div>
    <button type="button" class="btn-sec read-match-clear" data-match-clear="${esc(block.id)}">Clear all</button>`;
}

// ---------- 'ordering' recipe ----------

function orderingBody(block: PageBlock): string {
  const { prompt, items } = c<CardOrderingContent>(block);
  const rows = (items ?? [])
    .map(
      (it, i) => `<div class="read-order-row">
        <select class="read-order-select" data-order-select="${esc(block.id)}-${i}">
          <option value="">–</option>
          ${(items ?? []).map((_, n) => `<option value="${n + 1}">${n + 1}</option>`).join('')}
        </select>
        <span>${esc(it)}</span>
      </div>`,
    )
    .join('');
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}<div class="read-order">${rows}</div>`;
}

// ---------- 'categorize' recipe: sort items into labeled groups (click item, then click its group) ----------

function categorizeBody(block: PageBlock): string {
  const { prompt, groups, items } = c<CardCategorizeContent>(block);
  const groupsHtml = (groups ?? [])
    .map(
      (g, i) => `<div class="read-cat-group" data-cat-group="${esc(block.id)}-${i}" data-group-label="${esc(g)}">
      <div class="read-cat-group-label">${esc(g)}</div>
      <div class="read-cat-group-items" data-cat-group-items="${esc(block.id)}-${i}"></div>
    </div>`,
    )
    .join('');
  const itemsHtml = (items ?? [])
    .map((it, i) => `<button type="button" class="read-cat-item" data-cat-item="${esc(block.id)}-${i}" data-item-label="${esc(it)}">${esc(it)}</button>`)
    .join('');
  return `${prompt ? `<div class="book-prompt">${esc(prompt)}</div>` : ''}
    <div class="read-cat" data-cat-root="${esc(block.id)}">
      <div class="read-cat-items" data-cat-items="${esc(block.id)}">${itemsHtml}</div>
      <div class="read-cat-groups">${groupsHtml}</div>
    </div>
    <button type="button" class="btn-sec read-cat-clear" data-cat-clear="${esc(block.id)}">Clear all</button>`;
}

// ---------- 'speaking' / 'listening' recipes ----------

function speakingBody(block: PageBlock): string {
  const { prompt, note } = c<CardOpenTaskContent>(block);
  return `<div class="book-prompt">${esc(prompt ?? '')}</div>
    ${note ? `<div class="book-note">📌 ${esc(note)}</div>` : ''}
    <div class="read-speaking-badge">🎤 Speaking practice</div>
    ${renderActivityAudioArea(block.activity_audio_reference)}`;
}

function listeningBody(block: PageBlock): string {
  const { prompt, note } = c<CardOpenTaskContent>(block);
  return `<div class="book-prompt">${esc(prompt ?? '')}</div>
    ${note ? `<div class="book-note">📌 ${esc(note)}</div>` : ''}
    ${renderActivityAudioArea(block.activity_audio_reference)}`;
}

// ---------- image_ref / audio_ref (kind-based, unchanged from before) ----------

function imageRefBody(block: PageBlock): string {
  const content = block.content as { caption?: string };
  return `<div class="read-image-note">🖼️ Image on the original page${content?.caption ? ` — ${esc(content.caption)}` : ''} <span class="read-image-hint">(see the page image on the right)</span></div>`;
}

function audioRefBody(block: PageBlock, audioFilesById: Map<string, ImportAudioFile>): string {
  const content = block.content as { label: string; detectedTrackNumber?: string | null; matchedAudioAssetId?: string | null };
  const matchedFile = content.matchedAudioAssetId ? audioFilesById.get(content.matchedAudioAssetId) : undefined;
  const matchState = matchedFile ? 'matched' : 'unmatched';
  return `<div class="book-audio-ref" data-audio-ref-block="${esc(block.id)}" data-storage-path="${esc(matchedFile?.storage_path ?? '')}">
    ${matchedFile ? `<button type="button" class="chip audio" data-play-audio-ref="${esc(block.id)}">🔊 ${esc(content.label)}</button>` : `<span class="chip audio" style="opacity:.6">🔇 ${esc(content.label)}</span>`}
    ${content.detectedTrackNumber ? `<span class="book-src">track ${esc(content.detectedTrackNumber)}</span>` : ''}
    ${!matchedFile ? `<span class="audio-match-status ${matchState}">No audio file matched</span>` : ''}
  </div>`;
}

// ---------- recipe -> renderer ----------

const DOCUMENT_BODY_RENDERERS: Record<string, (b: PageBlock) => string> = {
  text: textBody,
  vocabulary: vocabularyBody,
  grammar_rule: grammarRuleBody,
  table: tableBody,
  dialogue: dialogueBody,
};

const INTERACTION_BODY_RENDERERS: Record<string, (b: PageBlock) => string> = {
  single_choice: singleChoiceBody,
  multi_select: multiSelectBody,
  text_input: textInputBody,
  matching_pairs: matchingBody,
  ordering: orderingBody,
  categorize: categorizeBody,
  speaking: speakingBody,
  listening: listeningBody,
  dialogue: dialogueBody,
  freeform: renderComposedActivity,
};

/**
 * Renders one block for Read Mode, wrapped in the standard learning-section
 * card. Never crashes on a broken/unrecognized block — falls back to a
 * plain-text card. `showNumBadge` should be false when the previous block in
 * the page has the same section_number (a multi-card exercise split into
 * sub-question cards) — see renderCardHeader.
 */
export function renderReadModeBlock(block: PageBlock, audioFilesById: Map<string, ImportAudioFile>, showNumBadge = true): string {
  if (block.kind === 'image_ref') return renderCard(block, imageRefBody(block), showNumBadge, 'image_ref');
  if (block.kind === 'audio_ref') return renderCard(block, audioRefBody(block, audioFilesById), showNumBadge, 'audio_ref');

  const recipe = resolveReadModeComponentType(block.kind, block.component_type, (block.content ?? {}) as Record<string, unknown>);
  const renderer = block.kind === 'interaction' ? INTERACTION_BODY_RENDERERS[recipe] : DOCUMENT_BODY_RENDERERS[recipe];

  let bodyHtml: string;
  try {
    bodyHtml = renderer ? renderer(block) : textBody(block);
  } catch {
    const fallback = block.content as { text?: string };
    bodyHtml = `<div class="read-raw-text"><span class="read-raw-flag">Unstructured content</span><pre>${esc(fallback?.text ?? block.source_text ?? '')}</pre></div>`;
  }
  return renderCard(block, bodyHtml, showNumBadge, recipe);
}

// ---------- wiring (interactivity + purely-visual affordances) ----------

function wirePronunciationIcons(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('[data-pron-play]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.add('pron-playing');
      toast('Pronunciation playback preview — audio not yet available.');
      setTimeout(() => btn.classList.remove('pron-playing'), 400);
    });
  });
}

function wireTranslationToggles(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('[data-translate-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = container.querySelector<HTMLElement>(`[data-translate-text="${btn.dataset.translateToggle}"]`);
      if (!text) return;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      text.hidden = expanded;
      btn.setAttribute('aria-expanded', String(!expanded));
      btn.textContent = expanded ? '🌐 Show English' : '🌐 Hide English';
    });
  });
}

function wireVerifyButtons(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('[data-verify-block]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const area = container.querySelector<HTMLElement>(`[data-feedback-area="${btn.dataset.verifyBlock}"]`);
      if (!area) return;
      area.hidden = !area.hidden;
      area.textContent = 'Answer key available — automatic verification is not yet enabled in this preview.';
    });
  });
}

function wireChoiceBlock(container: ParentNode): void {
  container.querySelectorAll<HTMLElement>('[data-choice-single], [data-choice-multi]').forEach((root) => {
    const isSingle = root.hasAttribute('data-choice-single');
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.read-choice-opt'));
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const selected = btn.getAttribute('aria-checked') === 'true';
        if (isSingle) {
          if (selected) {
            btn.setAttribute('aria-checked', 'false');
            btn.classList.remove('selected');
            return;
          }
          buttons.forEach((b) => {
            b.setAttribute('aria-checked', 'false');
            b.classList.remove('selected');
          });
          btn.setAttribute('aria-checked', 'true');
          btn.classList.add('selected');
        } else {
          btn.setAttribute('aria-checked', selected ? 'false' : 'true');
          btn.classList.toggle('selected', !selected);
        }
      });
    });
  });
}

const MATCH_COLOR_COUNT = 8;

interface MatchWireState {
  pending: { left?: HTMLButtonElement; right?: HTMLButtonElement };
  nextColor: number;
}
const matchState = new Map<string, MatchWireState>();

function clearPairVisuals(btn: HTMLButtonElement): void {
  for (let i = 0; i < MATCH_COLOR_COUNT; i++) btn.classList.remove(`match-pair-${i}`);
  btn.classList.remove('paired');
  delete btn.dataset.pairKey;
}

/** Two columns, color-linked pairs, click-to-unselect a pending pick, click-a-paired-item to break that pair, and Clear all — see spec section 5. */
function wireMatchingBlock(block: PageBlock, container: ParentNode): void {
  const root = container.querySelector<HTMLElement>(`[data-match-root="${block.id}"]`);
  if (!root) return;
  const state: MatchWireState = { pending: {}, nextColor: 0 };
  matchState.set(block.id, state);

  function breakPair(pairKey: string): void {
    root!.querySelectorAll<HTMLButtonElement>(`[data-pair-key="${pairKey}"]`).forEach(clearPairVisuals);
  }

  root.querySelectorAll<HTMLButtonElement>('.read-match-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.classList.contains('paired')) {
        const pairKey = el.dataset.pairKey;
        if (pairKey) breakPair(pairKey);
        return;
      }
      const side = el.dataset.side as 'left' | 'right';
      if (el.classList.contains('picked')) {
        el.classList.remove('picked');
        state.pending[side] = undefined;
        return;
      }
      if (state.pending[side]) state.pending[side]!.classList.remove('picked');
      state.pending[side] = el;
      el.classList.add('picked');
      if (state.pending.left && state.pending.right) {
        const left = state.pending.left;
        const right = state.pending.right;
        const colorIdx = state.nextColor % MATCH_COLOR_COUNT;
        state.nextColor++;
        const pairKey = `${block.id}-${left.dataset.idx}-${right.dataset.idx}-${colorIdx}`;
        left.dataset.pairKey = pairKey;
        right.dataset.pairKey = pairKey;
        left.classList.remove('picked');
        right.classList.remove('picked');
        left.classList.add('paired', `match-pair-${colorIdx}`);
        right.classList.add('paired', `match-pair-${colorIdx}`);
        state.pending = {};
      }
    });
  });

  container.querySelector<HTMLButtonElement>(`[data-match-clear="${block.id}"]`)?.addEventListener('click', () => {
    root!.querySelectorAll<HTMLButtonElement>('.read-match-item').forEach((el) => {
      clearPairVisuals(el);
      el.classList.remove('picked');
    });
    state.pending = {};
  });
}

interface CategorizeState {
  pending?: HTMLButtonElement;
}
const categorizeState = new Map<string, CategorizeState>();

/** Click an item to select it, then click a group to assign it there (color-coded, reusing the matching UI's palette). Click an assigned item again to send it back to the pool. Clear all resets everything. */
function wireCategorizeBlock(block: PageBlock, container: ParentNode): void {
  const root = container.querySelector<HTMLElement>(`[data-cat-root="${block.id}"]`);
  if (!root) return;
  const pool = root.querySelector<HTMLElement>(`[data-cat-items="${block.id}"]`);
  if (!pool) return;
  const state: CategorizeState = {};
  categorizeState.set(block.id, state);

  function unassign(el: HTMLButtonElement): void {
    el.classList.remove('assigned');
    for (let i = 0; i < MATCH_COLOR_COUNT; i++) el.classList.remove(`match-pair-${i}`);
    delete el.dataset.groupIdx;
    pool!.appendChild(el);
  }

  root.querySelectorAll<HTMLButtonElement>('.read-cat-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.classList.contains('assigned')) {
        unassign(el);
        return;
      }
      if (el.classList.contains('picked')) {
        el.classList.remove('picked');
        state.pending = undefined;
        return;
      }
      if (state.pending) state.pending.classList.remove('picked');
      state.pending = el;
      el.classList.add('picked');
    });
  });

  root.querySelectorAll<HTMLElement>('.read-cat-group').forEach((groupEl, groupIdx) => {
    groupEl.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.read-cat-item')) return; // let the item's own click handler deal with re-clicks
      if (!state.pending) return;
      const itemsContainer = groupEl.querySelector<HTMLElement>('[data-cat-group-items]');
      if (!itemsContainer) return;
      const item = state.pending;
      item.classList.remove('picked');
      item.classList.add('assigned', `match-pair-${groupIdx % MATCH_COLOR_COUNT}`);
      item.dataset.groupIdx = String(groupIdx);
      itemsContainer.appendChild(item);
      state.pending = undefined;
    });
  });

  container.querySelector<HTMLButtonElement>(`[data-cat-clear="${block.id}"]`)?.addEventListener('click', () => {
    root!.querySelectorAll<HTMLButtonElement>('.read-cat-item.assigned').forEach(unassign);
    if (state.pending) {
      state.pending.classList.remove('picked');
      state.pending = undefined;
    }
  });
}

/** Attaches interactivity for one rendered Read Mode block — call once per block after inserting its HTML. */
export function wireReadModeBlock(block: PageBlock, container: ParentNode): void {
  wirePronunciationIcons(container);
  wireVerifyButtons(container);
  wireTranslationToggles(container);

  const recipe = resolveReadModeComponentType(block.kind, block.component_type, (block.content ?? {}) as Record<string, unknown>);

  if (block.kind === 'interaction' && (recipe === 'single_choice' || recipe === 'multi_select')) {
    wireChoiceBlock(container);
  }
  if (block.kind === 'interaction' && recipe === 'matching_pairs') {
    wireMatchingBlock(block, container);
  }
  if (block.kind === 'interaction' && recipe === 'categorize') {
    wireCategorizeBlock(block, container);
  }
  if (block.kind === 'audio_ref') {
    const btn = container.querySelector<HTMLButtonElement>(`[data-play-audio-ref="${block.id}"]`);
    const storagePath = container.querySelector<HTMLElement>(`[data-audio-ref-block="${block.id}"]`)?.dataset.storagePath;
    if (btn && storagePath) btn.addEventListener('click', () => void playAudioRef(storagePath, btn));
  }
}

let currentAudioEl: HTMLAudioElement | null = null;

// Small in-memory cache so re-playing the same block doesn't re-fetch a signed URL every click.
const audioUrlCache = new Map<string, string>();

async function playAudioRef(storagePath: string, btn: HTMLButtonElement): Promise<void> {
  currentAudioEl?.pause();
  document.querySelectorAll('.chip.audio.playing').forEach((el) => el.classList.remove('playing'));
  try {
    let url = audioUrlCache.get(storagePath);
    if (!url) {
      url = await getImportAudioUrl(storagePath);
      audioUrlCache.set(storagePath, url);
    }
    const audio = new Audio(url);
    currentAudioEl = audio;
    btn.classList.add('playing');
    audio.addEventListener('ended', () => btn.classList.remove('playing'));
    audio.addEventListener('pause', () => btn.classList.remove('playing'));
    await audio.play();
  } catch {
    btn.classList.remove('playing');
  }
}
