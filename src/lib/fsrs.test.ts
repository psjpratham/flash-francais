import { describe, expect, it } from 'vitest';
import { formatDelta, previewAll, scheduleCard } from './fsrs';
import type { Card, Rating } from '../types';

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
    show_source_in_study: true,
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

  it('graduating Easy out of learning uses a boosted stability, not the original weak one', () => {
    // Started rough: brand-new card graded Again puts it into learning with
    // a small initial stability (W[0]).
    const afterAgain = scheduleCard(newCard(), 1, 0.9, NOW);
    const learningCard = newCard({
      state: 'learning',
      step: afterAgain.step!,
      difficulty: afterAgain.difficulty!,
      stability: afterAgain.stability!,
      due: afterAgain.due!,
    });

    // Now graded Easy on the very next look: graduation stability must be
    // strictly greater than the frozen post-Again stability (the actual
    // bug — Easy used to be discarded entirely here), and the 1-day floor
    // must still apply rather than a same-session due date.
    const patch = scheduleCard(learningCard, 4, 0.9, NOW + 60000);
    expect(patch.state).toBe('review');
    expect(patch.stability!).toBeGreaterThan(afterAgain.stability!);
    const intervalDays = (new Date(patch.due!).getTime() - (NOW + 60000)) / 86400000;
    expect(intervalDays).toBeGreaterThanOrEqual(1);
  });

  it('never schedules a review-state graduation less than a day out, even for a weak card', () => {
    const learningCard = newCard({ state: 'learning', step: 0, difficulty: 8, stability: 0.05 });
    const patch = scheduleCard(learningCard, 3, 0.9, NOW);
    if (patch.state === 'review') {
      const intervalDays = (new Date(patch.due!).getTime() - NOW) / 86400000;
      expect(intervalDays).toBeGreaterThanOrEqual(1);
    }
  });

  it('never lets a lapse come out more stable than the card was before lapsing', () => {
    const card = reviewCard({ difficulty: 9, stability: 2 });
    const patch = scheduleCard(card, 1, 0.9, NOW);
    expect(patch.state).toBe('relearning');
    expect(patch.stability!).toBeLessThanOrEqual(2);
  });

  /**
   * The whole point of previewAll is to show the learner, before they grade,
   * exactly what scheduleCard is about to do — the grade-button "back in
   * ___" badges and the post-swipe toast (session.ts) both read it. If those
   * two ever compute the due date differently (e.g. a future refactor
   * special-cases the preview instead of calling scheduleCard directly),
   * the UI would show one number and silently commit another — which is
   * indistinguishable, from the learner's side, from the scheduler being
   * broken. Pinned down explicitly here, across every state a card can be
   * in, so that class of drift fails a test instead of shipping quietly.
   */
  it('preview and actual scheduling always agree, for every card state and grade', () => {
    const cards: Card[] = [
      newCard(),
      newCard({ state: 'learning', step: 0, difficulty: 6, stability: 0.4 }),
      newCard({ state: 'learning', step: 1, difficulty: 6, stability: 0.4 }),
      newCard({ state: 'relearning', step: 0, difficulty: 8, stability: 0.1 }),
      reviewCard(),
      reviewCard({ difficulty: 9, stability: 2 }),
    ];
    const grades: Rating[] = [1, 2, 3, 4];

    for (const card of cards) {
      const preview = previewAll(card, 0.9, NOW);
      for (const g of grades) {
        const actual = scheduleCard(card, g, 0.9, NOW);
        expect(preview[g]).toBe(formatDelta(actual.due!, NOW));
      }
    }
  });
});
