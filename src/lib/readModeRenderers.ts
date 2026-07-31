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
  CardFlashcardContent,
  CardFlashcardDetail,
  CardFlashcardExample,
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
import { esc, errMsg, toast } from './dom';
import { getImportAudioUrl } from './imports';
import { resolveReadModeComponentType } from './legacyComponentMap';
import { renderComposedActivity } from './composedActivity';
import { renderRichText, renderRichTextPronounced, renderTextWithPronunciation } from './richText';
import { getSpokenAudioUrl } from './tts';

/** A pre-v13 card may still have a bare French string in detail.examples instead of an { fr, en } pair — never migrated in place, so both shapes are handled at render time. */
function normalizeExample(ex: CardFlashcardExample | string): { fr: string; en: string | null } {
  return typeof ex === 'string' ? { fr: ex, en: null } : { fr: ex.fr, en: ex.en ?? null };
}

/** Exported so flashcard front-face markup outside this file (session.ts/studyMode.ts) can render the same 🔊 icon — wire it via wirePronunciationIcons, also exported below. The emoji and the spinner both always exist in the DOM; CSS (.pron-icon.pron-loading) swaps which one is visible, so there's no re-render/content-swap race with playPronunciation's own state changes. */
export function pronIconHTML(text: string): string {
  return `<button type="button" class="pron-icon" data-pron-play data-pron-text="${esc(text)}" title="Play pronunciation"><span class="pron-icon-emoji">🔊</span><span class="pron-icon-spinner"></span></button>`;
}

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
  if (block.block_kind === 'image_ref') {
    const caption = (block.content as { caption?: string })?.caption;
    return !!caption && normalizeForDedup(caption) === titleNorm;
  }
  if (block.block_kind === 'audio_ref') {
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
  if (block.block_kind !== 'interaction') return '';
  const status: AnswerKeyStatus = block.answer_key_status ?? 'unknown';
  const cfg: Record<AnswerKeyStatus, { label: string; disabled: boolean; note: string; cls: string }> = {
    available: { label: 'Verify', disabled: false, note: '', cls: '' },
    // Answered by the model itself, not confirmed by the real answer key — Verify still works, but is visibly marked so it's never mistaken for a key-confirmed answer.
    inferred: { label: 'Verify (AI-answered)', disabled: false, note: 'Not from the answer key — the model’s own best judgment.', cls: 'read-verify-btn-inferred' },
    unavailable: { label: 'Verify — unavailable', disabled: true, note: 'No answer key available for this exercise yet.', cls: '' },
    unknown: { label: 'Verify — pending', disabled: true, note: 'Answer key status not yet determined.', cls: '' },
  };
  const s = cfg[status];
  return `<div class="read-verify-area">
    <button type="button" class="btn-sec read-verify-btn ${s.cls}" data-verify-block="${esc(block.id)}" ${s.disabled ? 'disabled' : ''}>${esc(s.label)}</button>
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

// vocabulary/table/flashcard already render their own precise, per-term/
// per-example pron-icons inline (see their body renderers) — a second,
// generic whole-card icon here would be redundant for those specifically.
// Every other recipe with real French content gets this one, so "can I
// hear this" stops depending on which recipe a card happens to use.
const RECIPES_WITH_OWN_PRON_ICONS = new Set(['vocabulary', 'table', 'flashcard']);

function renderPronArea(block: PageBlock, recipe: string): string {
  if (!block.pronunciation_enabled || RECIPES_WITH_OWN_PRON_ICONS.has(recipe)) return '';
  const text = getPrimaryBodyText(block, recipe);
  if (!text) return '';
  return `<div class="read-pron-area">${pronIconHTML(text)}<span class="read-pron-label">Play pronunciation</span></div>`;
}

function renderCard(block: PageBlock, bodyHtml: string, showNumBadge: boolean, recipe: string): string {
  const categoryAttr = block.category ? ` data-category="${esc(block.category)}"` : '';
  return `<div class="read-card" data-kind="${esc(block.block_kind ?? '')}"${categoryAttr}>
    ${renderCardHeader(block, showNumBadge, isTitleRedundant(block, recipe))}
    ${renderCardInstruction(block, isInstructionRedundant(block, recipe))}
    <div class="read-card-body">${bodyHtml}</div>
    ${renderPronArea(block, recipe)}
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
  const style = content.style ?? legacyTextStyle(block.component_type ?? '');
  const pron = block.pronunciation_enabled ?? false;

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
          ${pron ? pronIconHTML(p.term) : ''}
          ${p.translation ? `<span class="read-vocab-translation">${esc(p.translation)}</span>` : ''}
        </div>
        ${p.example ? `<div class="read-vocab-example">${esc(p.example)}</div>` : ''}
      </div>`,
    )
    .join('');
  return `${title ? `<div class="read-vocab-title">${esc(title)}</div>` : ''}<div class="read-vocab-group">${rows}</div>`;
}

// ---------- 'flashcard' recipe: a real recall card — Read Mode shows both faces at once (nothing to hide here, unlike Practice/Study) ----------

const FLASHCARD_DETAIL_LABELS: Record<string, string> = {
  ipa: 'IPA',
  register: 'Register',
  rule: 'Rule',
  wiktionary: 'Wiktionary',
  note: 'Note',
  tip: 'Tip',
};

/**
 * The flashcard back's rich-detail section, shared between Read Mode's
 * always-both-shown flashcardBody and Practice/Study's back face (session.ts
 * /studyMode.ts) — a card's back is the whole point of "detail", so it's
 * shown directly, never gated behind a further click. Examples come first
 * (the single most valuable field) as styled quote-like lines, then the
 * rest as a compact labeled panel, then a table if present.
 */
export function renderFlashcardDetailHTML(detail: CardFlashcardDetail | null | undefined): string {
  const d = detail ?? {};
  const detailKeys = Object.keys(FLASHCARD_DETAIL_LABELS) as ('ipa' | 'register' | 'rule' | 'wiktionary' | 'note' | 'tip')[];
  const rows = detailKeys
    .filter((key) => key !== 'ipa' && d[key])
    .map((key) => `<div class="pf-detail-row"><span class="pf-detail-label">${esc(FLASHCARD_DETAIL_LABELS[key])}</span><span class="pf-detail-value">${esc(d[key]!)}</span></div>`)
    .join('');
  const examplesHtml = d.examples?.length
    ? `<div class="pf-examples">${d.examples
        .map((ex) => {
          const { fr, en } = normalizeExample(ex);
          return `<div class="pf-example">
            <div class="pf-example-fr">${esc(fr)}${pronIconHTML(fr)}</div>
            ${en ? `<div class="pf-example-en">${esc(en)}</div>` : ''}
          </div>`;
        })
        .join('')}</div>`
    : '';
  const tableHtml = d.table?.length ? `<table class="pf-table">${d.table.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>` : '';
  if (!examplesHtml && !rows && !tableHtml) return '';
  return `<div class="pf-detail">${examplesHtml}${rows ? `<div class="pf-detail-grid">${rows}</div>` : ''}${tableHtml}</div>`;
}

function flashcardBody(block: PageBlock): string {
  const { front, back, detail } = c<CardFlashcardContent>(block);
  const d = detail ?? {};
  const detailKeys = Object.keys(FLASHCARD_DETAIL_LABELS) as ('ipa' | 'register' | 'rule' | 'wiktionary' | 'note' | 'tip')[];
  const detailRows = detailKeys
    .map((key) => {
      const value = d[key];
      if (!value) return '';
      return `<div class="read-flashcard-detail-row"><span class="read-flashcard-detail-label">${esc(FLASHCARD_DETAIL_LABELS[key])}</span><span>${esc(value)}</span></div>`;
    })
    .join('');
  const examplesHtml = d.examples?.length
    ? `<div class="read-flashcard-examples">${d.examples
        .map((ex) => {
          const { fr, en } = normalizeExample(ex);
          return `<div class="read-flashcard-example">
            <div class="read-flashcard-example-fr">${esc(fr)}${pronIconHTML(fr)}</div>
            ${en ? `<div class="read-flashcard-example-en">${esc(en)}</div>` : ''}
          </div>`;
        })
        .join('')}</div>`
    : '';
  const tableHtml = d.table?.length ? `<table class="p-tbl">${d.table.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>` : '';
  return `
    <div class="read-flashcard">
      <div class="read-flashcard-front">${esc(front)}${pronIconHTML(front)}</div>
      <div class="read-flashcard-back">${esc(back)}</div>
    </div>
    ${examplesHtml}
    ${detailRows ? `<div class="read-flashcard-detail">${detailRows}</div>` : ''}
    ${tableHtml}`;
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
          `<tr><td class="read-vocab-term">${esc(p.term)}${pron ? ' ' + pronIconHTML(p.term) : ''}</td><td>${esc(p.translation ?? '')}</td></tr>`,
      )
      .join('')}</table>`;
  }
  const headHtml = content.headers?.length ? `<tr>${content.headers.map((h) => `<td><strong>${esc(h)}</strong></td>`).join('')}</tr>` : '';
  return `<table class="p-tbl">${headHtml}${(content.rows ?? []).map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
}

// ---------- 'dialogue' recipe (reading, or fill-in-the-blank when interactive) ----------

function dialogueBody(block: PageBlock): string {
  const { turns } = c<{ turns: { speaker: string | null; text?: string; template?: string }[] }>(block);
  const pron = block.pronunciation_enabled ?? false;
  const isInteraction = block.block_kind === 'interaction';
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
        `<button type="button" class="read-choice-opt" role="radio" aria-checked="false" data-choice-value="${esc(o)}" data-idx="${i}" id="${esc(name)}-${i}"><span class="read-choice-mark read-choice-mark-radio"></span><span class="read-choice-label">${esc(o)}</span></button>`,
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
        `<button type="button" class="read-choice-opt" role="checkbox" aria-checked="false" data-choice-value="${esc(o)}" data-idx="${i}" id="${esc(name)}-${i}"><span class="read-choice-mark read-choice-mark-check"></span><span class="read-choice-label">${esc(o)}</span></button>`,
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
  const isLong = content.long === true || isLegacyLongForm(block.component_type ?? '');
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
  flashcard: flashcardBody,
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
  if (block.block_kind === 'image_ref') return renderCard(block, imageRefBody(block), showNumBadge, 'image_ref');
  if (block.block_kind === 'audio_ref') return renderCard(block, audioRefBody(block, audioFilesById), showNumBadge, 'audio_ref');

  const recipe = resolveReadModeComponentType(block.block_kind ?? 'document', block.component_type ?? '', (block.content ?? {}) as Record<string, unknown>);
  const renderer = block.block_kind === 'interaction' ? INTERACTION_BODY_RENDERERS[recipe] : DOCUMENT_BODY_RENDERERS[recipe];

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

let currentPronAudio: HTMLAudioElement | null = null;

async function playPronunciation(btn: HTMLButtonElement): Promise<void> {
  const text = btn.dataset.pronText;
  if (!text || btn.classList.contains('pron-loading')) return;
  currentPronAudio?.pause();
  document.querySelectorAll('.pron-icon.pron-playing').forEach((el) => el.classList.remove('pron-playing'));
  btn.classList.add('pron-loading');
  try {
    const url = await getSpokenAudioUrl(text);
    btn.classList.remove('pron-loading');
    const audio = new Audio(url);
    currentPronAudio = audio;
    btn.classList.add('pron-playing');
    audio.addEventListener('ended', () => btn.classList.remove('pron-playing'));
    audio.addEventListener('pause', () => btn.classList.remove('pron-playing'));
    await audio.play();
  } catch (e) {
    btn.classList.remove('pron-loading', 'pron-playing');
    toast('Could not play pronunciation: ' + errMsg(e));
  }
}

/** Wires every 🔊 icon within `container` to real on-demand pronunciation audio (see lib/tts.ts) — exported so flashcard face markup outside the read-mode-block system (session.ts/studyMode.ts's own front/back HTML) can wire its own pron-icons the same way. */
export function wirePronunciationIcons(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('[data-pron-play]').forEach((btn) => {
    btn.addEventListener('click', () => void playPronunciation(btn));
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

// ---------- real answer-checking (Verify), using answer fields populated from an attached answer key ----------

export interface VerifyOutcome {
  correct: boolean;
  summary: string;
}

function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function markVerify(el: Element | null, correct: boolean): void {
  el?.classList.remove('read-verify-correct', 'read-verify-incorrect');
  el?.classList.add(correct ? 'read-verify-correct' : 'read-verify-incorrect');
}

function verifySingleChoice(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const { correctOptions } = c<CardChoiceContent>(block);
  if (!correctOptions?.length) return null;
  const root = container.querySelector<HTMLElement>(`[data-choice-single="${block.id}"]`);
  if (!root) return null;
  const correctSet = new Set(correctOptions);
  let anySelected = false;
  let correct = true;
  root.querySelectorAll<HTMLButtonElement>('.read-choice-opt').forEach((btn) => {
    const idx = Number(btn.dataset.idx);
    const selected = btn.getAttribute('aria-checked') === 'true';
    const shouldBeSelected = correctSet.has(idx);
    if (selected) anySelected = true;
    btn.classList.remove('read-verify-correct', 'read-verify-incorrect');
    if (selected !== shouldBeSelected) correct = false;
    // Always reveal the correct option (green), and flag a wrongly-picked one (red) — never mark a merely-unselected-and-correctly-so option at all.
    if (selected || shouldBeSelected) markVerify(btn, shouldBeSelected);
  });
  if (!anySelected) return { correct: false, summary: 'Pick an answer first.' };
  return { correct, summary: correct ? 'Correct!' : 'Not quite — the correct answer is highlighted.' };
}

function verifyMultiSelect(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const { correctOptions } = c<CardChoiceContent>(block);
  if (!correctOptions?.length) return null;
  const root = container.querySelector<HTMLElement>(`[data-choice-multi="${block.id}"]`);
  if (!root) return null;
  const correctSet = new Set(correctOptions);
  let anySelected = false;
  let allMatch = true;
  root.querySelectorAll<HTMLButtonElement>('.read-choice-opt').forEach((btn) => {
    const idx = Number(btn.dataset.idx);
    const selected = btn.getAttribute('aria-checked') === 'true';
    const shouldBeSelected = correctSet.has(idx);
    if (selected) anySelected = true;
    btn.classList.remove('read-verify-correct', 'read-verify-incorrect');
    if (selected !== shouldBeSelected) allMatch = false;
    if (selected || shouldBeSelected) markVerify(btn, selected === shouldBeSelected);
  });
  if (!anySelected) return { correct: false, summary: 'Pick at least one answer first.' };
  return { correct: allMatch, summary: allMatch ? 'Correct!' : 'Not quite — correct options are highlighted.' };
}

function verifyMatchingPairs(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const { correctPairs } = c<CardMatchingContent>(block);
  if (!correctPairs?.length) return null;
  const root = container.querySelector<HTMLElement>(`[data-match-root="${block.id}"]`);
  if (!root) return null;
  const leftButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.read-match-item[data-side="left"]'));
  const rightByKey = new Map<string, HTMLButtonElement>();
  root.querySelectorAll<HTMLButtonElement>('.read-match-item[data-side="right"]').forEach((b) => {
    if (b.dataset.pairKey) rightByKey.set(b.dataset.pairKey, b);
  });
  const correctSet = new Set(correctPairs.map(([l, r]) => `${l}-${r}`));

  let madeAnyPair = false;
  let allCorrect = true;
  leftButtons.forEach((lb) => {
    lb.classList.remove('read-verify-correct', 'read-verify-incorrect');
    if (!lb.classList.contains('paired') || !lb.dataset.pairKey) return;
    madeAnyPair = true;
    const rb = lb.dataset.pairKey ? rightByKey.get(lb.dataset.pairKey) : undefined;
    rb?.classList.remove('read-verify-correct', 'read-verify-incorrect');
    const li = Number(lb.dataset.idx);
    const ri = rb ? Number(rb.dataset.idx) : -1;
    const isCorrect = correctSet.has(`${li}-${ri}`);
    if (!isCorrect) allCorrect = false;
    markVerify(lb, isCorrect);
    if (rb) markVerify(rb, isCorrect);
  });
  if (!madeAnyPair) return { correct: false, summary: 'Match some pairs first.' };
  const complete = leftButtons.every((lb) => lb.classList.contains('paired'));
  const correct = allCorrect && complete;
  return { correct, summary: correct ? 'Correct!' : 'Not quite — mismatched pairs are highlighted.' };
}

function verifyOrdering(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const { correctOrder, items } = c<CardOrderingContent>(block);
  if (!correctOrder?.length || !items?.length) return null;
  let allFilled = true;
  let allCorrect = true;
  items.forEach((_, i) => {
    const sel = container.querySelector<HTMLSelectElement>(`[data-order-select="${block.id}-${i}"]`);
    if (!sel) return;
    sel.classList.remove('read-verify-correct', 'read-verify-incorrect');
    if (!sel.value) {
      allFilled = false;
      return;
    }
    const expectedPosition = correctOrder.indexOf(i) + 1;
    const isCorrect = Number(sel.value) === expectedPosition;
    if (!isCorrect) allCorrect = false;
    markVerify(sel, isCorrect);
  });
  if (!allFilled) return { correct: false, summary: 'Order every item first.' };
  return { correct: allCorrect, summary: allCorrect ? 'Correct!' : 'Not quite — mismatched positions are highlighted.' };
}

function verifyCategorize(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const { correctGroups, items } = c<CardCategorizeContent>(block);
  if (!correctGroups?.length || !items?.length) return null;
  let allAssigned = true;
  let allCorrect = true;
  items.forEach((_, i) => {
    const el = container.querySelector<HTMLButtonElement>(`[data-cat-item="${block.id}-${i}"]`);
    if (!el) return;
    el.classList.remove('read-verify-correct', 'read-verify-incorrect');
    if (!el.classList.contains('assigned') || el.dataset.groupIdx === undefined) {
      allAssigned = false;
      return;
    }
    const isCorrect = Number(el.dataset.groupIdx) === correctGroups[i];
    if (!isCorrect) allCorrect = false;
    markVerify(el, isCorrect);
  });
  if (!allAssigned) return { correct: false, summary: 'Sort every item first.' };
  return { correct: allCorrect, summary: allCorrect ? 'Correct!' : 'Not quite — mismatched items are highlighted.' };
}

function verifyTextInput(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const content = block.content as CardTextInputContent;
  const answers = content.answers;
  if (!answers?.length) return null;
  let inputs: (HTMLInputElement | HTMLTextAreaElement | null)[] = [];
  if (content.template) {
    inputs = answers.map((_, i) => container.querySelector<HTMLInputElement>(`[data-blank-input="${block.id}-${i}"]`));
  } else if (content.fields?.length) {
    inputs = content.fields.map((f) => container.querySelector<HTMLInputElement>(`[data-mte-field="${block.id}-${f.id}"]`));
  } else {
    inputs = [container.querySelector<HTMLInputElement>(`[data-text-entry="${block.id}"]`)];
  }
  if (!inputs.some((el) => el)) return null;

  let allFilled = true;
  let allCorrect = true;
  inputs.forEach((input, i) => {
    if (!input) return;
    input.classList.remove('read-verify-correct', 'read-verify-incorrect');
    const val = input.value.trim();
    const expected = answers[i];
    if (!val) {
      allFilled = false;
      return;
    }
    const isCorrect = expected != null && normalizeAnswer(val) === normalizeAnswer(expected);
    if (!isCorrect) allCorrect = false;
    markVerify(input, isCorrect);
  });
  if (!allFilled) return { correct: false, summary: 'Fill in every blank first.' };
  return { correct: allCorrect, summary: allCorrect ? 'Correct!' : 'Not quite — incorrect answers are highlighted.' };
}

function verifyDialogue(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const { turns } = c<{ turns: { answer?: string | null }[] }>(block);
  const answerable = (turns ?? []).map((t, i) => ({ i, answer: t.answer })).filter((t): t is { i: number; answer: string } => t.answer != null);
  if (!answerable.length) return null;

  let allFilled = true;
  let allCorrect = true;
  let anyInput = false;
  for (const { i, answer } of answerable) {
    const input = container.querySelector<HTMLInputElement>(`[data-blank-input="${block.id}-${i}-0"]`);
    if (!input) continue;
    anyInput = true;
    input.classList.remove('read-verify-correct', 'read-verify-incorrect');
    const val = input.value.trim();
    if (!val) {
      allFilled = false;
      continue;
    }
    const isCorrect = normalizeAnswer(val) === normalizeAnswer(answer);
    if (!isCorrect) allCorrect = false;
    markVerify(input, isCorrect);
  }
  if (!anyInput) return null;
  if (!allFilled) return { correct: false, summary: 'Fill in every blank first.' };
  return { correct: allCorrect, summary: allCorrect ? 'Correct!' : 'Not quite — incorrect answers are highlighted.' };
}

// ---------- capturing/restoring the learner's in-progress answer (Study mode persistence) ----------
// Deliberately separate from the verify* functions above: those check a
// live attempt against a known-correct answer; these just read/write
// whatever's currently in the widget, correct or not, so Study mode can
// survive a re-render (or a reload) without silently discarding it.

type CapturedState = Record<string, unknown>;

function captureChoiceState(block: PageBlock, container: ParentNode, multi: boolean): CapturedState | null {
  const root = container.querySelector<HTMLElement>(`[data-choice-${multi ? 'multi' : 'single'}="${block.id}"]`);
  if (!root) return null;
  const selected: number[] = [];
  root.querySelectorAll<HTMLButtonElement>('.read-choice-opt').forEach((btn) => {
    if (btn.getAttribute('aria-checked') === 'true') selected.push(Number(btn.dataset.idx));
  });
  return selected.length ? { selected } : null;
}

function applyChoiceState(block: PageBlock, container: ParentNode, multi: boolean, state: CapturedState): void {
  const root = container.querySelector<HTMLElement>(`[data-choice-${multi ? 'multi' : 'single'}="${block.id}"]`);
  const selected = state.selected;
  if (!root || !Array.isArray(selected)) return;
  const selectedSet = new Set(selected as number[]);
  root.querySelectorAll<HTMLButtonElement>('.read-choice-opt').forEach((btn) => {
    const sel = selectedSet.has(Number(btn.dataset.idx));
    btn.setAttribute('aria-checked', String(sel));
    btn.classList.toggle('selected', sel);
  });
}

/** Covers text_input's template/fields/single/long shapes AND an interactive dialogue's inline blanks — every one of these uses the same data-blank-input/-mte-field/-text-entry/-long-writing attributes as their identifying key, so one capture/apply pair works for both recipes. */
function captureTextInputState(block: PageBlock, container: ParentNode): CapturedState | null {
  const values: Record<string, string> = {};
  container.querySelectorAll<HTMLInputElement>(`[data-blank-input^="${block.id}-"]`).forEach((el) => {
    values[`blank:${el.dataset.blankInput}`] = el.value;
  });
  container.querySelectorAll<HTMLInputElement>(`[data-mte-field^="${block.id}-"]`).forEach((el) => {
    values[`mte:${el.dataset.mteField}`] = el.value;
  });
  const single = container.querySelector<HTMLInputElement>(`[data-text-entry="${block.id}"]`);
  if (single) values['entry'] = single.value;
  const long = container.querySelector<HTMLTextAreaElement>(`[data-long-writing="${block.id}"]`);
  if (long) values['long'] = long.value;
  return Object.values(values).some((v) => v.trim()) ? { values } : null;
}

function applyTextInputState(block: PageBlock, container: ParentNode, state: CapturedState): void {
  const values = state.values as Record<string, string> | undefined;
  if (!values) return;
  container.querySelectorAll<HTMLInputElement>(`[data-blank-input^="${block.id}-"]`).forEach((el) => {
    const v = values[`blank:${el.dataset.blankInput}`];
    if (v != null) el.value = v;
  });
  container.querySelectorAll<HTMLInputElement>(`[data-mte-field^="${block.id}-"]`).forEach((el) => {
    const v = values[`mte:${el.dataset.mteField}`];
    if (v != null) el.value = v;
  });
  const single = container.querySelector<HTMLInputElement>(`[data-text-entry="${block.id}"]`);
  if (single && values['entry'] != null) single.value = values['entry'];
  const long = container.querySelector<HTMLTextAreaElement>(`[data-long-writing="${block.id}"]`);
  if (long && values['long'] != null) long.value = values['long'];
}

function captureMatchingState(block: PageBlock, container: ParentNode): CapturedState | null {
  const root = container.querySelector<HTMLElement>(`[data-match-root="${block.id}"]`);
  if (!root) return null;
  const pairs: [number, number][] = [];
  const seenKeys = new Set<string>();
  root.querySelectorAll<HTMLButtonElement>('.read-match-item[data-side="left"].paired').forEach((lb) => {
    const key = lb.dataset.pairKey;
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    const rb = root.querySelector<HTMLButtonElement>(`.read-match-item[data-side="right"][data-pair-key="${key}"]`);
    if (rb) pairs.push([Number(lb.dataset.idx), Number(rb.dataset.idx)]);
  });
  return pairs.length ? { pairs } : null;
}

/** Restores saved pairs directly (bypassing the click-to-pair wiring's own color/pending bookkeeping) — a freshly-added pair after a restore may reuse a color already used by a restored pair; a harmless cosmetic overlap, never a correctness issue. */
function applyMatchingState(block: PageBlock, container: ParentNode, state: CapturedState): void {
  const pairs = state.pairs as [number, number][] | undefined;
  if (!pairs?.length) return;
  const root = container.querySelector<HTMLElement>(`[data-match-root="${block.id}"]`);
  if (!root) return;
  pairs.forEach(([li, ri], i) => {
    const lb = root.querySelector<HTMLButtonElement>(`.read-match-item[data-side="left"][data-idx="${li}"]`);
    const rb = root.querySelector<HTMLButtonElement>(`.read-match-item[data-side="right"][data-idx="${ri}"]`);
    if (!lb || !rb) return;
    const colorIdx = i % MATCH_COLOR_COUNT;
    const pairKey = `${block.id}-${li}-${ri}-${colorIdx}`;
    lb.dataset.pairKey = pairKey;
    rb.dataset.pairKey = pairKey;
    lb.classList.add('paired', `match-pair-${colorIdx}`);
    rb.classList.add('paired', `match-pair-${colorIdx}`);
  });
}

function captureOrderingState(block: PageBlock, container: ParentNode): CapturedState | null {
  const values: Record<string, string> = {};
  container.querySelectorAll<HTMLSelectElement>(`[data-order-select^="${block.id}-"]`).forEach((el) => {
    if (el.dataset.orderSelect) values[el.dataset.orderSelect] = el.value;
  });
  return Object.values(values).some((v) => v) ? { values } : null;
}

function applyOrderingState(block: PageBlock, container: ParentNode, state: CapturedState): void {
  const values = state.values as Record<string, string> | undefined;
  if (!values) return;
  container.querySelectorAll<HTMLSelectElement>(`[data-order-select^="${block.id}-"]`).forEach((el) => {
    const v = el.dataset.orderSelect ? values[el.dataset.orderSelect] : undefined;
    if (v) el.value = v;
  });
}

function captureCategorizeState(block: PageBlock, container: ParentNode): CapturedState | null {
  const root = container.querySelector<HTMLElement>(`[data-cat-root="${block.id}"]`);
  if (!root) return null;
  const assignments: Record<string, number> = {};
  root.querySelectorAll<HTMLButtonElement>('.read-cat-item.assigned').forEach((el) => {
    if (el.dataset.catItem && el.dataset.groupIdx !== undefined) assignments[el.dataset.catItem] = Number(el.dataset.groupIdx);
  });
  return Object.keys(assignments).length ? { assignments } : null;
}

/** Moves each restored item into its saved group directly (same DOM move wireCategorizeBlock's click handler does), so a later "Clear all"/re-assign click works exactly as if the learner had just placed it there. */
function applyCategorizeState(block: PageBlock, container: ParentNode, state: CapturedState): void {
  const assignments = state.assignments as Record<string, number> | undefined;
  if (!assignments) return;
  const root = container.querySelector<HTMLElement>(`[data-cat-root="${block.id}"]`);
  if (!root) return;
  Object.entries(assignments).forEach(([key, groupIdx]) => {
    const item = root.querySelector<HTMLButtonElement>(`[data-cat-item="${key}"]`);
    const itemsContainer = root.querySelector<HTMLElement>(`[data-cat-group-items="${block.id}-${groupIdx}"]`);
    if (!item || !itemsContainer) return;
    item.classList.add('assigned', `match-pair-${groupIdx % MATCH_COLOR_COUNT}`);
    item.dataset.groupIdx = String(groupIdx);
    itemsContainer.appendChild(item);
  });
}

/** Reads whatever's currently in an interactive card's widget — correct or not — for Study mode to persist. Null for a recipe with nothing to capture (speaking/listening/freeform/document recipes) or when nothing's been entered. */
export function captureAnswerState(block: PageBlock, container: ParentNode): CapturedState | null {
  const recipe = resolveReadModeComponentType(block.block_kind ?? 'document', block.component_type ?? '', (block.content ?? {}) as Record<string, unknown>);
  switch (recipe) {
    case 'single_choice':
      return captureChoiceState(block, container, false);
    case 'multi_select':
      return captureChoiceState(block, container, true);
    case 'matching_pairs':
      return captureMatchingState(block, container);
    case 'ordering':
      return captureOrderingState(block, container);
    case 'categorize':
      return captureCategorizeState(block, container);
    case 'text_input':
    case 'dialogue':
      return captureTextInputState(block, container);
    default:
      return null;
  }
}

/** The inverse of captureAnswerState — call right after wireReadModeBlock, before wiring answer-capture, so a restored pick/pair/value is in place before any further interaction. */
export function applyAnswerState(block: PageBlock, container: ParentNode, state: CapturedState | null | undefined): void {
  if (!state) return;
  const recipe = resolveReadModeComponentType(block.block_kind ?? 'document', block.component_type ?? '', (block.content ?? {}) as Record<string, unknown>);
  switch (recipe) {
    case 'single_choice':
      applyChoiceState(block, container, false, state);
      break;
    case 'multi_select':
      applyChoiceState(block, container, true, state);
      break;
    case 'matching_pairs':
      applyMatchingState(block, container, state);
      break;
    case 'ordering':
      applyOrderingState(block, container, state);
      break;
    case 'categorize':
      applyCategorizeState(block, container, state);
      break;
    case 'text_input':
    case 'dialogue':
      applyTextInputState(block, container, state);
      break;
  }
}

/** Fires `onChange` with the freshly-captured state on any input/click/change bubbling up from this block's widget — one generic delegated listener instead of per-recipe wiring, since captureAnswerState already knows how to read whatever recipe this is. */
export function wireAnswerCapture(block: PageBlock, container: ParentNode, onChange: (state: CapturedState | null) => void): void {
  const handler = (): void => onChange(captureAnswerState(block, container));
  container.addEventListener('input', handler);
  container.addEventListener('click', handler);
  container.addEventListener('change', handler);
}

/**
 * Runs the same answer-check Verify already uses, exported for Practice/
 * Study mode's generation-mode flip: flipping a non-flashcard generation-mode
 * card reveals correct/incorrect right on the same live widget (no re-render,
 * so the learner's picks aren't lost), then grading appears. Returns null for
 * a recipe/card with nothing checkable (no answer field populated, or a
 * recipe like speaking/listening with no answer concept at all) — callers
 * should still let the learner proceed straight to grading in that case.
 */
export function computeVerifyOutcome(block: PageBlock, container: ParentNode): VerifyOutcome | null {
  const recipe = resolveReadModeComponentType(block.block_kind ?? 'document', block.component_type ?? '', (block.content ?? {}) as Record<string, unknown>);
  switch (recipe) {
    case 'single_choice':
      return verifySingleChoice(block, container);
    case 'multi_select':
      return verifyMultiSelect(block, container);
    case 'matching_pairs':
      return verifyMatchingPairs(block, container);
    case 'ordering':
      return verifyOrdering(block, container);
    case 'categorize':
      return verifyCategorize(block, container);
    case 'text_input':
      return verifyTextInput(block, container);
    case 'dialogue':
      return verifyDialogue(block, container);
    default:
      return null;
  }
}

function wireVerifyButtons(block: PageBlock, container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('[data-verify-block]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const area = container.querySelector<HTMLElement>(`[data-feedback-area="${btn.dataset.verifyBlock}"]`);
      if (!area) return;
      const outcome = computeVerifyOutcome(block, container);
      area.classList.remove('correct', 'incorrect');
      if (!outcome) {
        area.hidden = !area.hidden;
        area.textContent = 'No checkable answer on this card.';
        return;
      }
      area.hidden = false;
      area.classList.add(outcome.correct ? 'correct' : 'incorrect');
      area.textContent = (outcome.correct ? '✓ ' : '✗ ') + outcome.summary;
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
  wireVerifyButtons(block, container);
  wireTranslationToggles(container);

  const recipe = resolveReadModeComponentType(block.block_kind ?? 'document', block.component_type ?? '', (block.content ?? {}) as Record<string, unknown>);

  if (block.block_kind === 'interaction' && (recipe === 'single_choice' || recipe === 'multi_select')) {
    wireChoiceBlock(container);
  }
  if (block.block_kind === 'interaction' && recipe === 'matching_pairs') {
    wireMatchingBlock(block, container);
  }
  if (block.block_kind === 'interaction' && recipe === 'categorize') {
    wireCategorizeBlock(block, container);
  }
  if (block.block_kind === 'audio_ref') {
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
