import { describe, expect, it } from 'vitest';
import { renderComposedActivity, validateComposedRoot } from './composedActivity';
import type { PageBlock } from '../types';

function block(content: unknown, sourceText = 'fallback source text'): PageBlock {
  return {
    id: 'b1',
    stack_id: 'e1',
    deck_id: 'deck-1',
    order_index: 0,
    origin: 'textbook_extraction',
    source_page_id: 'p1',
    block_kind: 'interaction',
    component_type: 'composed_activity',
    section_number: null,
    title: null,
    instruction: null,
    language: null,
    source_line_ids: [],
    source_text: sourceText,
    content: content as PageBlock['content'],
    translation: null,
    category: null,
    tags: [],
    answer_key_status: 'unknown',
    prompt_generated: false,
    study_answer: null,
    pronunciation_enabled: false,
    activity_audio_reference: null,
    needs_review: false,
    review_reason: null,
    show_source_in_practice: true,
    show_source_in_study: true,
    note_type: null,
    fields: null,
    review_status: null,
    confidence: null,
    review_reasons: null,
    source_evidence: null,
    extraction_diagnostics: null,
    state: 'new',
    due: '',
    difficulty: null,
    stability: null,
    reps: 0,
    lapses: 0,
    step: 0,
    last_review: null,
    include_in_practice: false,
    created_at: '',
    updated_at: '',
  };
}

describe('validateComposedRoot', () => {
  it('accepts a tree built only from allowlisted primitives', () => {
    const root = { type: 'column', children: [{ type: 'label', text: 'Hi' }, { type: 'short_input', id: 'a' }] };
    expect(validateComposedRoot(root)).toEqual(root);
  });

  it('rejects a node using a type outside the allowlist', () => {
    expect(validateComposedRoot({ type: 'script', text: 'alert(1)' })).toBeNull();
  });

  it('rejects a tree with a disallowed type nested inside children', () => {
    const root = { type: 'row', children: [{ type: 'iframe', text: 'x' }] };
    expect(validateComposedRoot(root)).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateComposedRoot('not an object')).toBeNull();
    expect(validateComposedRoot(null)).toBeNull();
    expect(validateComposedRoot(undefined)).toBeNull();
  });

  it('rejects a tree deeper than the max depth', () => {
    let root: Record<string, unknown> = { type: 'label', text: 'leaf' };
    for (let i = 0; i < 10; i++) root = { type: 'group', children: [root] };
    expect(validateComposedRoot(root)).toBeNull();
  });

  it('rejects a tree with more nodes than the max count', () => {
    const children = Array.from({ length: 300 }, () => ({ type: 'spacer' }));
    expect(validateComposedRoot({ type: 'column', children })).toBeNull();
  });
});

describe('renderComposedActivity', () => {
  it('renders a valid composed tree without treating any field as HTML', () => {
    const html = renderComposedActivity(block({ root: { type: 'label', text: '<script>alert(1)</script>' } }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('falls back to the block source text (never crashes) when the tree is invalid', () => {
    const html = renderComposedActivity(block({ root: { type: 'not_a_real_primitive' } }, 'Exact source wording'));
    expect(html).toContain('composed-fallback');
    expect(html).toContain('Exact source wording');
  });

  it('falls back safely when content.root is missing entirely', () => {
    const html = renderComposedActivity(block({}, 'Exact source wording'));
    expect(html).toContain('composed-fallback');
  });
});
