// Structural validation + demotion for one page's raw model response.
//
// Deliberate policy shift from earlier versions of this file: we now trust
// the model's structural judgment (which recipe fits, how a card is laid
// out) much more, and verify much less — see the card-recipes redesign.
// What stays strict is (a) recognizing a genuinely broken/unknown block and
// demoting it rather than storing garbage, (b) the 'freeform' recipe's
// primitive-tree safety validation (an allowlist is a security boundary —
// untrusted model output is never trusted structurally there, regardless of
// how much we trust it elsewhere), and (c) wording fidelity, which is
// checked separately and deterministically by coverage.ts against
// source_line_ids/source_text — that never gets relaxed.
//
// Philosophy unchanged from before: a block with a structurally broken
// shape is never dropped — it's demoted to a 'text' block preserving
// whatever source_text/source_line_ids it had, with needs_review + a
// review_reason explaining exactly what was demoted. Only a block with
// literally nothing preservable (no source_text at all) is rejected
// outright, and even then only that one block is dropped — never the whole
// page (see validatePage).

import { BLOCK_KINDS, COMPOSED_PRIMITIVE_TYPES } from './prompts/pageExtraction.ts';

export type BlockKind = (typeof BLOCK_KINDS)[number];

export interface ValidatedBlock {
  order_index: number;
  kind: BlockKind;
  component_type: string;
  section_number: string | null;
  title: string | null;
  instruction: string | null;
  source_line_ids: string[];
  source_text: string;
  content: Record<string, unknown>;
  /** A faithful English translation of this card, generated separately from source_text — never a substitute for it. Null when the model didn't provide one (e.g. an image_ref/audio_ref card with nothing to translate). */
  translation: string | null;
  /** A closed semantic label (see CardCategory in src/types) driving icon/accent decoration the frontend fully owns — never model-authored styling. Invalid/unrecognized values fall back to null rather than being rejected. */
  category: string | null;
  /** Open, growing, multi-value topic/skill classification — see TAGS in pageExtraction.ts. Normalized (trimmed, kebab-cased, deduped, capped) but never validated against a closed list; new tags are expected and get upserted into the shared pool by extractWorker.ts. */
  tags: string[];
  needs_review: boolean;
  review_reason: string | null;
  /** 'available' when this block's answer field(s) in `content` were populated from an attached answer key, 'inferred' when the key didn't cover it but the model confidently answered it itself (an objective/mechanical item only), 'unavailable' when a key was attached but didn't cover this item and it wasn't confidently inferrable, null/unset when no key was attached at all (today's default — see readModeRenderers.ts's Verify area). Invalid/unrecognized values fall back to null. */
  answer_key_status: 'available' | 'unavailable' | 'unknown' | 'inferred' | null;
}

export interface ValidatedPage {
  page_number: number | null;
  detected_language: string | null;
  blocks: ValidatedBlock[];
  page_warnings: { code: string; message: string; source_line_ids?: string[] }[];
  unresolved_references: unknown[];
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

const MAX_TAGS_PER_BLOCK = 4;

/** Trims, lowercases, kebab-cases, dedupes, and caps a model-provided tags array — never rejects an unrecognized tag (the whole point is an open, growing pool), just normalizes its shape. */
function normalizeTags(v: unknown): string[] {
  if (!isStringArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    const normalized = raw
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_TAGS_PER_BLOCK) break;
  }
  return out;
}

// A small, generic set of card recipes — not a taxonomy of textbook
// phrasings. 'dialogue' is valid under both document (plain reading) and
// interaction (fill-in-the-blank turns) kinds.
const DOCUMENT_RECIPES = new Set(['text', 'vocabulary', 'flashcard', 'grammar_rule', 'table', 'dialogue']);
const INTERACTION_RECIPES = new Set(['single_choice', 'multi_select', 'text_input', 'matching_pairs', 'ordering', 'categorize', 'speaking', 'listening', 'dialogue', 'freeform']);
const CATEGORIES = new Set(['vocabulary', 'grammar', 'culture', 'reading', 'exercise', 'audio', 'writing']);
const COMPOSED_TYPES = new Set<string>(COMPOSED_PRIMITIVE_TYPES);
const MAX_COMPOSED_DEPTH = 6;
const MAX_COMPOSED_NODES = 200;

/** True page furniture — a card whose only content is a bare page number (with common surrounding punctuation) has zero learning value and is dropped deterministically, never left to prompt compliance alone. */
const PAGE_NUMBER_ONLY_RE = /^[\s\-–—.·•]*\d{1,4}[\s\-–—.·•]*$/;

function isPageNumberOnlyCard(block: ValidatedBlock): boolean {
  if (block.kind !== 'document' || block.component_type !== 'text') return false;
  const content = block.content as { text?: unknown; nodes?: { spans?: { text?: unknown }[] }[] };
  let plain = '';
  if (typeof content.text === 'string') plain = content.text;
  else if (Array.isArray(content.nodes)) {
    plain = content.nodes.map((n) => (n.spans ?? []).map((s) => (typeof s.text === 'string' ? s.text : '')).join('')).join(' ');
  }
  return plain.trim() !== '' && PAGE_NUMBER_ONLY_RE.test(plain.trim());
}

/** Structurally validates a freeform node tree against the same allowlist the frontend renderer enforces — a malformed/unlisted primitive here means the block gets demoted rather than ever being stored as a broken freeform tree. This is the one place content validation stays strict: the allowlist is a rendering-safety boundary, not a quality check. */
function isValidComposedNode(raw: unknown, depth: number, counter: { n: number }): boolean {
  if (depth > MAX_COMPOSED_DEPTH) return false;
  counter.n++;
  if (counter.n > MAX_COMPOSED_NODES) return false;
  if (typeof raw !== 'object' || raw === null) return false;
  const n = raw as Record<string, unknown>;
  if (typeof n.type !== 'string' || !COMPOSED_TYPES.has(n.type)) return false;
  if (n.children !== undefined) {
    if (!Array.isArray(n.children)) return false;
    for (const child of n.children) {
      if (!isValidComposedNode(child, depth + 1, counter)) return false;
    }
  }
  return true;
}

/** Light sanity check only — is there anything here at all? Per-field shape policing was removed on purpose (see file header): a card whose fields don't perfectly match what a stricter schema would have wanted is still rendered, tolerantly, by the frontend. Only 'freeform' gets a real structural check, because that one is a safety boundary. */
function contentProblems(recipe: string, content: Record<string, unknown>): string[] {
  if (recipe === 'freeform') {
    const counter = { n: 0 };
    if (!content.root || !isValidComposedNode(content.root, 0, counter)) return ['root'];
    return [];
  }
  if (Object.keys(content).length === 0) return ['empty content'];
  return [];
}

function toRawText(raw: Record<string, unknown>, reason: string): ValidatedBlock | null {
  const sourceText = typeof raw.source_text === 'string' ? raw.source_text : '';
  if (!sourceText.trim()) return null; // nothing preservable
  return {
    order_index: typeof raw.order_index === 'number' ? raw.order_index : 0,
    kind: 'document',
    component_type: 'text',
    section_number: typeof raw.section_number === 'string' ? raw.section_number : null,
    title: typeof raw.title === 'string' ? raw.title : null,
    instruction: typeof raw.instruction === 'string' ? raw.instruction : null,
    source_line_ids: isStringArray(raw.source_line_ids) ? raw.source_line_ids : [],
    source_text: sourceText,
    content: { text: sourceText },
    translation: typeof raw.translation === 'string' ? raw.translation : null,
    category: null,
    tags: normalizeTags(raw.tags),
    needs_review: true,
    review_reason: reason,
    answer_key_status: null,
  };
}

const ANSWER_KEY_STATUSES = new Set(['available', 'unavailable', 'unknown', 'inferred']);

export function validateBlock(raw: unknown, path: string): ValidationResult<ValidatedBlock> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${path}: block is not an object` };
  const b = raw as Record<string, unknown>;

  const orderIndex = typeof b.order_index === 'number' ? b.order_index : 0;
  const sourceLineIds = isStringArray(b.source_line_ids) ? b.source_line_ids : [];
  const sourceText = typeof b.source_text === 'string' ? b.source_text : '';
  const content = typeof b.content === 'object' && b.content !== null ? (b.content as Record<string, unknown>) : {};
  const modelNeedsReview = b.needs_review === true;
  const modelReviewReason = typeof b.review_reason === 'string' ? b.review_reason : null;

  const kind = typeof b.kind === 'string' ? b.kind : null;
  // image_ref/audio_ref have exactly one valid component_type, equal to the
  // kind itself — a model that got the kind right but left component_type
  // null/missing on one of these shouldn't lose the block over a redundant
  // field it didn't need to fill in.
  const inferredComponentType = kind === 'image_ref' || kind === 'audio_ref' ? kind : null;
  const componentType = typeof b.component_type === 'string' ? b.component_type : inferredComponentType;

  if (kind === null || !BLOCK_KINDS.includes(kind as BlockKind)) {
    const demoted = toRawText(b, `demoted: invalid/missing kind "${String(b.kind)}"`);
    if (!demoted) return { ok: false, error: `${path}: invalid kind and nothing preservable` };
    return { ok: true, value: demoted };
  }
  if (componentType === null) {
    const demoted = toRawText(b, 'demoted: missing component_type');
    if (!demoted) return { ok: false, error: `${path}: missing component_type and nothing preservable` };
    return { ok: true, value: demoted };
  }

  const kindMatchesType =
    (kind === 'document' && DOCUMENT_RECIPES.has(componentType)) ||
    (kind === 'interaction' && INTERACTION_RECIPES.has(componentType)) ||
    (kind === 'image_ref' && componentType === 'image_ref') ||
    (kind === 'audio_ref' && componentType === 'audio_ref');

  if (!kindMatchesType) {
    const demoted = toRawText(b, `demoted: component_type "${componentType}" does not match kind "${kind}"`);
    if (!demoted) return { ok: false, error: `${path}: kind/component_type mismatch and nothing preservable` };
    return { ok: true, value: demoted };
  }

  const problems = contentProblems(componentType, content);
  if (problems.length > 0) {
    const demoted = toRawText(b, `demoted: ${componentType} missing/invalid ${problems.join(', ')}`);
    if (!demoted) return { ok: false, error: `${path}: ${componentType} content invalid and nothing preservable` };
    return { ok: true, value: demoted };
  }

  return {
    ok: true,
    value: {
      order_index: orderIndex,
      kind: kind as BlockKind,
      component_type: componentType,
      section_number: typeof b.section_number === 'string' ? b.section_number : null,
      title: typeof b.title === 'string' ? b.title : null,
      instruction: typeof b.instruction === 'string' ? b.instruction : null,
      source_line_ids: sourceLineIds,
      source_text: sourceText,
      content,
      translation: typeof b.translation === 'string' ? b.translation : null,
      category: typeof b.category === 'string' && CATEGORIES.has(b.category) ? b.category : null,
      tags: normalizeTags(b.tags),
      needs_review: modelNeedsReview,
      review_reason: modelReviewReason,
      answer_key_status: typeof b.answer_key_status === 'string' && ANSWER_KEY_STATUSES.has(b.answer_key_status) ? (b.answer_key_status as 'available' | 'unavailable' | 'unknown' | 'inferred') : null,
    },
  };
}

// Light guardrail on card segmentation (spec: "light, not too restrictive")
// — a page wildly outside this range isn't rejected or corrected, just
// flagged for a human to glance at.
const TYPICAL_MIN_CARDS = 2;
const TYPICAL_MAX_CARDS = 40;

export function validatePage(parsed: unknown): ValidationResult<ValidatedPage> {
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).blocks)) {
    return { ok: false, error: 'top-level "blocks" array missing' };
  }
  const p = parsed as Record<string, unknown>;
  const rawBlocks = p.blocks as unknown[];
  if (!rawBlocks.length) return { ok: false, error: 'blocks array is empty' };

  // One irrecoverable block (no source_text at all to fall back to) must
  // never discard everything else the model got right — it's dropped, with
  // a page_warning recording exactly what was lost, rather than failing the
  // whole page. Only "the model returned nothing usable at all" fails outright.
  let blocks: ValidatedBlock[] = [];
  const droppedBlockWarnings: { code: string; message: string; source_line_ids?: string[] }[] = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const r = validateBlock(rawBlocks[i], `blocks[${i}]`);
    if (!r.ok || !r.value) {
      droppedBlockWarnings.push({ code: 'dropped_block', message: `blocks[${i}] dropped: ${r.error ?? 'invalid and nothing preservable'}` });
      continue;
    }
    blocks.push(r.value);
  }
  if (blocks.length === 0) return { ok: false, error: 'no block in the page could be validated or preserved' };

  // True page furniture (bare page numbers) has zero learning value — drop
  // it deterministically rather than relying only on the model to skip it.
  // Never let this empty out an otherwise-valid page.
  const withoutPageNumbers = blocks.filter((b) => !isPageNumberOnlyCard(b));
  const pageNumberCardsDropped = blocks.length - withoutPageNumbers.length;
  if (pageNumberCardsDropped > 0 && withoutPageNumbers.length > 0) {
    droppedBlockWarnings.push({ code: 'dropped_page_number_card', message: `Dropped ${pageNumberCardsDropped} bare page-number card(s) — no learning content.` });
    blocks = withoutPageNumbers;
  }

  if (blocks.length < TYPICAL_MIN_CARDS || blocks.length > TYPICAL_MAX_CARDS) {
    droppedBlockWarnings.push({ code: 'unusual_card_count', message: `Page produced ${blocks.length} card(s) — outside the typical ${TYPICAL_MIN_CARDS}-${TYPICAL_MAX_CARDS} range, worth a glance.` });
  }

  const pageWarnings = Array.isArray(p.page_warnings)
    ? (p.page_warnings as unknown[])
        .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
        .map((w) => ({
          code: typeof w.code === 'string' ? w.code : 'unknown',
          message: typeof w.message === 'string' ? w.message : '',
          source_line_ids: isStringArray(w.source_line_ids) ? w.source_line_ids : undefined,
        }))
    : [];

  return {
    ok: true,
    value: {
      page_number: typeof p.page_number === 'number' ? p.page_number : null,
      detected_language: typeof p.detected_language === 'string' ? p.detected_language : null,
      blocks,
      page_warnings: [...pageWarnings, ...droppedBlockWarnings],
      unresolved_references: Array.isArray(p.unresolved_references) ? p.unresolved_references : [],
    },
  };
}
