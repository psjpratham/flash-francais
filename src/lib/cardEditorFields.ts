// Recipe-aware "just edit the content" fields for the manual card editor —
// deliberately NOT a recipe switcher (see pageReview.ts's card editor):
// each recipe gets a small, fixed set of plain-language fields matching its
// current shape. Changing what KIND of card something is happens through
// the prompt-edit box instead, never through this form.
//
// List-shaped fields (options, examples, items, groups...) are edited as
// one-per-line plain text rather than a dynamic add/remove-row widget —
// far friendlier than raw JSON, much less UI machinery than a full
// drag-and-drop row editor. Object-list fields (vocabulary pairs, dialogue
// turns) use a single delimited line per entry for the same reason.

import type { CardDialogueContent, CardFlashcardContent, CardVocabularyContent } from '../types';
import { esc } from './dom';

type FieldSpec =
  | { key: string; label: string; kind: 'text'; hint?: string }
  | { key: string; label: string; kind: 'textarea'; hint?: string }
  | { key: string; label: string; kind: 'list'; hint?: string }
  | { key: string; label: string; kind: 'checkbox'; hint?: string }
  // The three kinds below edit an answer field (populated only from an
  // attached answer key — see ANSWER KEY in pageExtraction.ts) as
  // human-friendly 1-based positions rather than raw 0-based JSON indices,
  // so an admin correcting a wrong extracted answer never has to think in
  // array-index terms. Blank input parses to null (no answer), same as a
  // plain text field.
  | { key: string; label: string; kind: 'indices'; hint?: string } // comma-separated 1-based positions -> number[]
  | { key: string; label: string; kind: 'index-per-line'; hint?: string } // one 1-based position per line, aligned to another list field -> number[]
  | { key: string; label: string; kind: 'pairs'; hint?: string }; // one "left#-right#" per line (1-based) -> [number, number][]

/** One entry per recipe with a structured editor. Anything not listed here (table, freeform, legacy types) falls back to a labeled JSON box rather than blocking on building every recipe. Fields not named here (e.g. text_input's `fields[]`) are preserved untouched on save, never dropped. */
const RECIPE_FIELDS: Record<string, FieldSpec[]> = {
  text: [{ key: 'text', label: 'Text', kind: 'textarea' }],
  grammar_rule: [
    { key: 'rule', label: 'Rule', kind: 'textarea' },
    { key: 'examples', label: 'Examples', kind: 'list', hint: 'one per line' },
  ],
  single_choice: [
    { key: 'prompt', label: 'Prompt', kind: 'textarea' },
    { key: 'options', label: 'Options', kind: 'list', hint: 'one per line' },
    { key: 'correctOptions', label: 'Correct option', kind: 'indices', hint: '1-based position in Options above, e.g. 2 — leave blank if no answer key' },
  ],
  multi_select: [
    { key: 'prompt', label: 'Prompt', kind: 'textarea' },
    { key: 'options', label: 'Options', kind: 'list', hint: 'one per line' },
    { key: 'correctOptions', label: 'Correct option(s)', kind: 'indices', hint: '1-based positions in Options above, comma-separated, e.g. 1, 3 — leave blank if no answer key' },
  ],
  text_input: [
    { key: 'prompt', label: 'Prompt', kind: 'textarea' },
    { key: 'template', label: 'Blank template (optional)', kind: 'text', hint: 'use ____ for the blank' },
    { key: 'long', label: 'Long-form answer', kind: 'checkbox' },
    { key: 'answers', label: 'Answers', kind: 'list', hint: 'one per line, in order (matching each blank/field above) — leave blank if no answer key; never set for a long-form answer' },
  ],
  ordering: [
    { key: 'prompt', label: 'Prompt (optional)', kind: 'text' },
    { key: 'items', label: 'Items, in the correct order', kind: 'list', hint: 'one per line' },
    { key: 'correctOrder', label: 'Correct order', kind: 'indices', hint: '1-based item positions in the correct sequence, comma-separated, e.g. 3, 1, 2 — leave blank if no answer key' },
  ],
  categorize: [
    { key: 'prompt', label: 'Prompt (optional)', kind: 'text' },
    { key: 'groups', label: 'Groups', kind: 'list', hint: 'one per line' },
    { key: 'items', label: 'Items to sort', kind: 'list', hint: 'one per line' },
    { key: 'correctGroups', label: 'Correct group per item', kind: 'index-per-line', hint: 'one per line, matching each item above in order — 1-based position in Groups above — leave blank if no answer key' },
  ],
  matching_pairs: [
    { key: 'prompt', label: 'Prompt (optional)', kind: 'text' },
    { key: 'left', label: 'Left column', kind: 'list', hint: 'one per line' },
    { key: 'right', label: 'Right column', kind: 'list', hint: 'same order as left, one per line' },
    { key: 'correctPairs', label: 'Correct pairs', kind: 'pairs', hint: 'one per line: left#-right# (1-based), e.g. 1-2 — leave blank if no answer key' },
  ],
  speaking: [
    { key: 'prompt', label: 'Prompt', kind: 'textarea' },
    { key: 'note', label: 'Note (optional)', kind: 'text' },
  ],
  listening: [
    { key: 'prompt', label: 'Prompt', kind: 'textarea' },
    { key: 'note', label: 'Note (optional)', kind: 'text' },
  ],
  image_ref: [{ key: 'caption', label: 'Caption (optional)', kind: 'text' }],
  audio_ref: [{ key: 'label', label: 'Label', kind: 'text' }],
};

export function renderContentFieldsHTML(recipe: string, content: Record<string, unknown>): string {
  if (recipe === 'vocabulary') return renderVocabularyFields(content as CardVocabularyContent);
  if (recipe === 'flashcard') return renderFlashcardFields(content as CardFlashcardContent);
  if (recipe === 'dialogue') return renderDialogueFields(content as CardDialogueContent);
  const spec = RECIPE_FIELDS[recipe];
  if (!spec) {
    return `<div class="field"><label>Content <span class="field-hint">— no simple editor for "${esc(recipe)}" yet, edit the raw JSON</span></label><textarea name="content_json" rows="7" class="mono">${esc(JSON.stringify(content ?? {}, null, 2))}</textarea></div>`;
  }
  return spec.map((s) => renderField(s, content[s.key])).join('');
}

export type ParsedContent = { ok: true; content: Record<string, unknown> } | { ok: false; error: string };

export function parseContentFields(recipe: string, form: HTMLFormElement, existingContent: Record<string, unknown>): ParsedContent {
  if (recipe === 'vocabulary') return { ok: true, content: parseVocabularyFields(form) };
  if (recipe === 'flashcard') return { ok: true, content: parseFlashcardFields(form, existingContent as CardFlashcardContent) };
  if (recipe === 'dialogue') return { ok: true, content: parseDialogueFields(form) };
  const spec = RECIPE_FIELDS[recipe];
  if (!spec) {
    const raw = (form.querySelector('[name="content_json"]') as HTMLTextAreaElement | null)?.value ?? '{}';
    try {
      return { ok: true, content: JSON.parse(raw) };
    } catch {
      return { ok: false, error: 'Content is not valid JSON' };
    }
  }
  const content: Record<string, unknown> = { ...existingContent };
  for (const s of spec) content[s.key] = parseField(s, form);
  return { ok: true, content };
}

function renderField(spec: FieldSpec, value: unknown): string {
  const hint = spec.hint ? ` <span class="field-hint">— ${esc(spec.hint)}</span>` : '';
  if (spec.kind === 'checkbox') {
    return `<label class="checkbox-field"><input type="checkbox" name="content_${spec.key}" ${value ? 'checked' : ''}> ${esc(spec.label)}</label>`;
  }
  if (spec.kind === 'text') {
    return `<div class="field"><label>${esc(spec.label)}${hint}</label><input name="content_${spec.key}" value="${esc((value as string) ?? '')}"></div>`;
  }
  if (spec.kind === 'textarea') {
    return `<div class="field"><label>${esc(spec.label)}${hint}</label><textarea name="content_${spec.key}" rows="4">${esc((value as string) ?? '')}</textarea></div>`;
  }
  if (spec.kind === 'indices') {
    const arr = Array.isArray(value) ? (value as number[]) : [];
    return `<div class="field"><label>${esc(spec.label)}${hint}</label><input name="content_${spec.key}" value="${esc(arr.map((n) => n + 1).join(', '))}"></div>`;
  }
  if (spec.kind === 'index-per-line') {
    const arr = Array.isArray(value) ? (value as number[]) : [];
    return `<div class="field"><label>${esc(spec.label)}${hint}</label><textarea name="content_${spec.key}" rows="${Math.max(3, arr.length)}" class="mono">${esc(arr.map((n) => n + 1).join('\n'))}</textarea></div>`;
  }
  if (spec.kind === 'pairs') {
    const arr = Array.isArray(value) ? (value as [number, number][]) : [];
    return `<div class="field"><label>${esc(spec.label)}${hint}</label><textarea name="content_${spec.key}" rows="${Math.max(3, arr.length)}" class="mono">${esc(arr.map(([l, r]) => `${l + 1}-${r + 1}`).join('\n'))}</textarea></div>`;
  }
  const items = Array.isArray(value) ? (value as unknown[]).map((v) => String(v)) : [];
  return `<div class="field"><label>${esc(spec.label)}${hint}</label><textarea name="content_${spec.key}" rows="${Math.max(3, items.length)}" class="mono">${esc(items.join('\n'))}</textarea></div>`;
}

/** Parses "3, 1, 2" (1-based, comma/newline-separated) into [2, 0, 1] (0-based); non-numeric/blank entries are dropped rather than rejected outright. */
function parseIndices(raw: string): number[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0);
}

/** Parses "1-2\n3-1" (1-based) into [[0,1],[2,0]]; a malformed line is dropped rather than rejected outright. */
function parsePairs(raw: string): [number, number][] {
  const pairs: [number, number][] = [];
  for (const line of raw.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const [l, r] = line.split('-').map((s) => Number(s.trim()) - 1);
    if (Number.isInteger(l) && l >= 0 && Number.isInteger(r) && r >= 0) pairs.push([l, r]);
  }
  return pairs;
}

function parseField(spec: FieldSpec, form: HTMLFormElement): unknown {
  const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="content_${spec.key}"]`);
  if (!el) return undefined;
  if (spec.kind === 'checkbox') return (el as HTMLInputElement).checked;
  if (spec.kind === 'list') return el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (spec.kind === 'indices' || spec.kind === 'index-per-line') {
    const parsed = spec.kind === 'indices' ? parseIndices(el.value) : el.value.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => Number(s) - 1);
    return parsed.length ? parsed : null;
  }
  if (spec.kind === 'pairs') {
    const parsed = parsePairs(el.value);
    return parsed.length ? parsed : null;
  }
  const v = el.value.trim();
  return v || (spec.kind === 'text' ? null : '');
}

function renderVocabularyFields(content: CardVocabularyContent): string {
  const pairs = content.pairs ?? [];
  return `
    <div class="field"><label>Title (optional)</label><input name="content_title" value="${esc(content.title ?? '')}"></div>
    <div class="field"><label>Terms <span class="field-hint">— one per line: term | translation | example (translation and example optional)</span></label>
      <textarea name="content_pairs" rows="${Math.max(4, pairs.length)}" class="mono">${esc(pairs.map((p) => [p.term, p.translation ?? '', p.example ?? ''].join(' | ')).join('\n'))}</textarea>
    </div>`;
}

function parseVocabularyFields(form: HTMLFormElement): CardVocabularyContent {
  const title = (form.querySelector('[name="content_title"]') as HTMLInputElement | null)?.value.trim() || null;
  const raw = (form.querySelector('[name="content_pairs"]') as HTMLTextAreaElement | null)?.value ?? '';
  const pairs = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [term, translation, example] = line.split('|').map((s) => s.trim());
      return { term: term ?? '', translation: translation || null, example: example || null };
    });
  return { title, pairs };
}

/** detail.table isn't editable here (rare on a flashcard, and a full grid editor isn't worth the UI machinery) — preserved untouched on save via parseFlashcardFields's existingContent param, same principle as RECIPE_FIELDS preserving fields it doesn't name. */
function renderFlashcardFields(content: CardFlashcardContent): string {
  const d = content.detail ?? {};
  return `
    <div class="field"><label>Front</label><textarea name="content_front" rows="2">${esc(content.front ?? '')}</textarea></div>
    <div class="field"><label>Back</label><textarea name="content_back" rows="2">${esc(content.back ?? '')}</textarea></div>
    <div class="field"><label>IPA (optional)</label><input name="content_detail_ipa" value="${esc(d.ipa ?? '')}"></div>
    <div class="field"><label>Examples <span class="field-hint">— one per line, "French | English"</span></label><textarea name="content_detail_examples" rows="${Math.max(2, d.examples?.length ?? 0)}" class="mono">${esc(
      (d.examples ?? []).map((ex) => (typeof ex === 'string' ? ex : `${ex.fr} | ${ex.en}`)).join('\n'),
    )}</textarea></div>
    <div class="field"><label>Wiktionary (optional)</label><input name="content_detail_wiktionary" value="${esc(d.wiktionary ?? '')}"></div>
    <div class="field"><label>Rule (optional)</label><input name="content_detail_rule" value="${esc(d.rule ?? '')}"></div>
    <div class="field"><label>Register (optional)</label><input name="content_detail_register" value="${esc(d.register ?? '')}"></div>
    <div class="field"><label>Note (optional)</label><input name="content_detail_note" value="${esc(d.note ?? '')}"></div>
    <div class="field"><label>Tip (optional)</label><input name="content_detail_tip" value="${esc(d.tip ?? '')}"></div>`;
}

function parseFlashcardFields(form: HTMLFormElement, existingContent: CardFlashcardContent): CardFlashcardContent {
  const val = (name: string) => (form.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ?? '';
  const front = val('content_front');
  const back = val('content_back');
  const examples = val('content_detail_examples')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [fr, en] = line.split('|').map((s) => s.trim());
      return { fr: fr ?? '', en: en ?? '' };
    });
  const detail = {
    ipa: val('content_detail_ipa') || null,
    examples: examples.length ? examples : null,
    wiktionary: val('content_detail_wiktionary') || null,
    rule: val('content_detail_rule') || null,
    register: val('content_detail_register') || null,
    note: val('content_detail_note') || null,
    tip: val('content_detail_tip') || null,
    table: existingContent.detail?.table ?? null,
  };
  const hasDetail = Object.values(detail).some((v) => v !== null);
  return { front, back, detail: hasDetail ? detail : null };
}

function renderDialogueFields(content: CardDialogueContent): string {
  const turns = content.turns ?? [];
  return `<div class="field"><label>Turns <span class="field-hint">— one per line: Speaker: text (leave speaker blank for none)</span></label>
    <textarea name="content_turns" rows="${Math.max(4, turns.length)}" class="mono">${esc(turns.map((t) => `${t.speaker ?? ''}: ${t.text}`).join('\n'))}</textarea></div>
    <div class="field"><label>Blank answers <span class="field-hint">— one per line, aligned to the turns above in order; only needed for a turn with a ____ blank — leave a line blank for a turn with no answer key coverage</span></label>
    <textarea name="content_turn_answers" rows="${Math.max(4, turns.length)}" class="mono">${esc(turns.map((t) => t.answer ?? '').join('\n'))}</textarea></div>`;
}

function parseDialogueFields(form: HTMLFormElement): CardDialogueContent {
  const raw = (form.querySelector('[name="content_turns"]') as HTMLTextAreaElement | null)?.value ?? '';
  const turns = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx < 0) return { speaker: null, text: line };
      const speaker = line.slice(0, idx).trim();
      const text = line.slice(idx + 1).trim();
      return { speaker: speaker || null, text };
    });
  const answersRaw = (form.querySelector('[name="content_turn_answers"]') as HTMLTextAreaElement | null)?.value ?? '';
  const answerLines = answersRaw.split('\n');
  return { turns: turns.map((t, i) => ({ ...t, answer: answerLines[i]?.trim() || null })) };
}
