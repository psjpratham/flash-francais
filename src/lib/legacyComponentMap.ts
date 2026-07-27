// Maps component_type values written by pre-card-recipe extraction prompts
// (both the original flat v1 taxonomy and the intermediate 26-type v2/v3
// taxonomy) to the closest current card recipe — applied only at render
// time. Old page_blocks rows are never migrated or rewritten; this keeps
// them rendering correctly forever without a destructive backfill.

import type { PageBlockKind } from '../types';

const LEGACY_DOCUMENT_MAP: Record<string, string> = {
  // v1 flat taxonomy
  heading: 'text',
  paragraph: 'text',
  caption: 'text',
  instruction: 'text',
  example: 'text',
  reference: 'text',
  note: 'text',
  grammar: 'text',
  // v2/v3 26-type taxonomy
  page_heading: 'text',
  section_heading: 'text',
  formatted_text: 'text',
  reading_passage: 'text',
  // shared / already correct under the new recipe set
  vocabulary: 'vocabulary', // legacy {pairs:[{term,translation}]} is a subset of the new CardVocabularyContent shape — tolerated directly
  dialogue: 'dialogue',
  table: 'table',
  raw_text: 'text',
};

const LEGACY_INTERACTION_MAP: Record<string, string> = {
  // v1 flat taxonomy
  fill_blank: 'text_input',
  writing: 'text_input',
  short_answer: 'text_input',
  // v2/v3 26-type taxonomy
  inline_fill_blank: 'text_input',
  text_entry: 'text_input',
  multi_text_entry: 'text_input',
  long_writing: 'text_input',
  dialogue_completion: 'dialogue',
  composed_activity: 'freeform',
  // shared / already correct under the new recipe set
  matching: 'matching_pairs',
  ordering: 'ordering',
  speaking: 'speaking',
  listening: 'listening',
};

const NEW_DOCUMENT_RECIPES = new Set(['text', 'vocabulary', 'grammar_rule', 'table', 'dialogue']);
const NEW_INTERACTION_RECIPES = new Set([
  'single_choice',
  'multi_select',
  'text_input',
  'matching_pairs',
  'ordering',
  'speaking',
  'listening',
  'dialogue',
  'freeform',
]);

/** Resolves a possibly-legacy component_type to the card recipe that should render it — a no-op for rows already written under the current schema. */
export function resolveReadModeComponentType(kind: PageBlockKind, componentType: string, content: Record<string, unknown>): string {
  if (kind === 'image_ref') return 'image_ref';
  if (kind === 'audio_ref') return 'audio_ref';
  if (kind === 'document') {
    if (NEW_DOCUMENT_RECIPES.has(componentType)) return componentType;
    return LEGACY_DOCUMENT_MAP[componentType] ?? 'text';
  }
  if (kind === 'interaction') {
    if (NEW_INTERACTION_RECIPES.has(componentType)) return componentType;
    if (componentType === 'multiple_choice') return content.multi === true ? 'multi_select' : 'single_choice';
    return LEGACY_INTERACTION_MAP[componentType] ?? 'text_input';
  }
  return componentType;
}
