import { describe, expect, it } from 'vitest';
import { resolveReadModeComponentType } from './legacyComponentMap';

describe('resolveReadModeComponentType', () => {
  it('passes through current-schema document recipes unchanged', () => {
    expect(resolveReadModeComponentType('document', 'text', {})).toBe('text');
    expect(resolveReadModeComponentType('document', 'table', {})).toBe('table');
  });

  it('passes through current-schema interaction recipes unchanged', () => {
    expect(resolveReadModeComponentType('interaction', 'text_input', {})).toBe('text_input');
    expect(resolveReadModeComponentType('interaction', 'freeform', {})).toBe('freeform');
  });

  it('maps v1 legacy document types to their closest recipe', () => {
    expect(resolveReadModeComponentType('document', 'heading', {})).toBe('text');
    expect(resolveReadModeComponentType('document', 'paragraph', {})).toBe('text');
    expect(resolveReadModeComponentType('document', 'caption', {})).toBe('text');
    expect(resolveReadModeComponentType('document', 'raw_text', {})).toBe('text');
    expect(resolveReadModeComponentType('document', 'vocabulary', {})).toBe('vocabulary');
  });

  it('maps v2/v3 26-type document types to their closest recipe', () => {
    expect(resolveReadModeComponentType('document', 'page_heading', {})).toBe('text');
    expect(resolveReadModeComponentType('document', 'section_heading', {})).toBe('text');
    expect(resolveReadModeComponentType('document', 'reading_passage', {})).toBe('text');
  });

  it('demotes an unrecognized document type to text rather than crashing', () => {
    expect(resolveReadModeComponentType('document', 'totally_unknown', {})).toBe('text');
  });

  it('splits legacy multiple_choice into single_choice or multi_select based on content.multi', () => {
    expect(resolveReadModeComponentType('interaction', 'multiple_choice', {})).toBe('single_choice');
    expect(resolveReadModeComponentType('interaction', 'multiple_choice', { multi: false })).toBe('single_choice');
    expect(resolveReadModeComponentType('interaction', 'multiple_choice', { multi: true })).toBe('multi_select');
  });

  it('maps other legacy interaction types to their closest recipe', () => {
    expect(resolveReadModeComponentType('interaction', 'fill_blank', {})).toBe('text_input');
    expect(resolveReadModeComponentType('interaction', 'short_answer', {})).toBe('text_input');
    expect(resolveReadModeComponentType('interaction', 'multi_text_entry', {})).toBe('text_input');
    expect(resolveReadModeComponentType('interaction', 'writing', {})).toBe('text_input');
    expect(resolveReadModeComponentType('interaction', 'matching', {})).toBe('matching_pairs');
    expect(resolveReadModeComponentType('interaction', 'dialogue_completion', {})).toBe('dialogue');
    expect(resolveReadModeComponentType('interaction', 'composed_activity', {})).toBe('freeform');
  });

  it('demotes an unrecognized interaction type to text_input rather than crashing', () => {
    expect(resolveReadModeComponentType('interaction', 'totally_unknown', {})).toBe('text_input');
  });

  it('leaves image_ref/audio_ref kinds untouched', () => {
    expect(resolveReadModeComponentType('image_ref', 'image_ref', {})).toBe('image_ref');
    expect(resolveReadModeComponentType('audio_ref', 'audio_ref', {})).toBe('audio_ref');
  });
});
