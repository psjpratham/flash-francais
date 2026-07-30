import { describe, expect, it } from 'vitest';
import { scheduleCard } from './fsrs';
import type { Card } from '../types';

const NOW = new Date('2026-07-24T12:00:00.000Z').getTime();

function newCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    stack_id: 'stack-1',
    deck_id: 'deck-1',
    order_index: 0,
    origin: 'manual',
    source_page_id: null,
    block_kind: null,
    component_type: null,
    section_number: null,
    title: null,
    instruction: null,
    language: null,
    source_line_ids: null,
    source_text: null,
    content: null,
    translation: null,
    category: null,
    answer_key_status: null,
    prompt_generated: false,
    study_answer: null,
    pronunciation_enabled: null,
    activity_audio_reference: null,
    needs_review: null,
    review_reason: null,
    show_source_in_practice: true,
    tags: [],
    note_type: 'basic',
    fields: {},
    review_status: null,
    confidence: null,
    review_reasons: null,
    source_evidence: null,
    extraction_diagnostics: null,
    state: 'new',
    due: new Date(NOW).toISOString(),
    difficulty: 0,
    stability: 0,
    reps: 0,
    lapses: 0,
    step: 0,
    last_review: null,
    include_in_practice: true,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function reviewCard(overrides: Partial<Card> = {}): Card {
  const lastReview = NOW - 10 * 86400000; // reviewed 10 days ago
  return newCard({
    state: 'review',
    difficulty: 5,
    stability: 8,
    reps: 3,
    lapses: 0,
    step: 0,
    due: new Date(NOW - 60000).toISOString(), // already due
    last_review: new Date(lastReview).toISOString(),
    ...overrides,
  });
}

describe('scheduleCard', () => {
  it('sends a brand-new card graded Again into learning', () => {
    const card = newCard();
    const patch = scheduleCard(card, 1, 0.9, NOW);
    expect(patch.state).toBe('learning');
  });

  it('graduates a brand-new card graded Easy straight to review', () => {
    const card = newCard();
    const patch = scheduleCard(card, 4, 0.9, NOW);
    expect(patch.state).toBe('review');
  });

  it('sends a review-state card graded Again into relearning and increments lapses', () => {
    const card = reviewCard({ lapses: 2 });
    const patch = scheduleCard(card, 1, 0.9, NOW);
    expect(patch.state).toBe('relearning');
    expect(patch.lapses).toBe(3);
  });

  it('keeps a review-state card graded Good in review with a later due date', () => {
    const card = reviewCard();
    const patch = scheduleCard(card, 3, 0.9, NOW);
    expect(patch.state).toBe('review');
    expect(new Date(patch.due!).getTime()).toBeGreaterThan(new Date(card.due).getTime());
  });
});
