import type { Card, CardUpdate, Rating } from '../types';

/**
 * FSRS-5 scheduler, ported 1:1 from the old flashcards.html prototype.
 * Pure functions only — no Supabase calls here.
 */

const W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const LEARN_STEPS_MIN = [1, 10];
const RELEARN_STEPS_MIN = [10];
const MIN_S = 0.01;

function clampD(d: number): number {
  return Math.min(10, Math.max(1, d));
}
function retrievability(elapsedDays: number, S: number): number {
  if (!S || S <= 0) return 0;
  return Math.pow(1 + (FACTOR * elapsedDays) / S, DECAY);
}
function intervalDaysForRetention(r: number, S: number): number {
  return Math.max(1 / 1440, (S / FACTOR) * (Math.pow(r, 1 / DECAY) - 1));
}
function initialStability(g: Rating): number {
  return Math.max(MIN_S, W[g - 1]);
}
function d0(g: Rating): number {
  return clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
}
function nextDifficulty(D: number, g: Rating): number {
  const deltaD = -W[6] * (g - 3);
  const Dp = D + (deltaD * (10 - D)) / 9;
  const target = d0(4);
  return clampD(W[7] * target + (1 - W[7]) * Dp);
}
function nextStabilityRecall(D: number, S: number, R: number, g: Rating): number {
  const hardPenalty = g === 2 ? W[15] : 1;
  const easyBonus = g === 4 ? W[16] : 1;
  const inc =
    Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1) * hardPenalty * easyBonus +
    1;
  return Math.max(MIN_S, S * inc);
}
function nextStabilityForget(D: number, S: number, R: number): number {
  return Math.max(MIN_S, W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R)));
}

/** Given a card + grade + desired retention, returns the new card fields (does not mutate). */
export function scheduleCard(card: Card, grade: Rating, retention: number, now?: number): CardUpdate {
  now = now ?? Date.now();
  const elapsedDays = card.last_review ? (now - new Date(card.last_review).getTime()) / 86400000 : 0;
  const out: CardUpdate & { reps: number; lapses: number; last_review: string } = {
    reps: card.reps + 1,
    lapses: card.lapses,
    last_review: new Date(now).toISOString(),
  };

  if (card.state === 'new') {
    const D = d0(grade);
    const S = initialStability(grade);
    out.difficulty = D;
    out.stability = S;
    if (grade === 1) {
      out.state = 'learning';
      out.step = 0;
      out.due = new Date(now + LEARN_STEPS_MIN[0] * 60000).toISOString();
    } else if (grade === 2) {
      out.state = 'learning';
      out.step = 0;
      out.due = new Date(now + LEARN_STEPS_MIN[0] * 60000).toISOString();
    } else if (grade === 3) {
      if (LEARN_STEPS_MIN.length > 1) {
        out.state = 'learning';
        out.step = 1;
        out.due = new Date(now + LEARN_STEPS_MIN[1] * 60000).toISOString();
      } else {
        out.state = 'review';
        out.due = new Date(now + intervalDaysForRetention(retention, S) * 86400000).toISOString();
      }
    } else {
      out.state = 'review';
      out.due = new Date(now + intervalDaysForRetention(retention, S) * 86400000).toISOString();
    }
    return out;
  }

  if (card.state === 'learning' || card.state === 'relearning') {
    const steps = card.state === 'learning' ? LEARN_STEPS_MIN : RELEARN_STEPS_MIN;
    out.difficulty = card.difficulty;
    out.stability = card.stability;
    if (grade === 1) {
      out.state = card.state;
      out.step = 0;
      out.due = new Date(now + steps[0] * 60000).toISOString();
    } else if (grade === 2) {
      out.state = card.state;
      out.step = card.step;
      out.due = new Date(now + steps[card.step] * 60000).toISOString();
    } else {
      const nextStep = card.step + 1;
      if (grade === 3 && nextStep < steps.length) {
        out.state = card.state;
        out.step = nextStep;
        out.due = new Date(now + steps[nextStep] * 60000).toISOString();
      } else {
        out.state = 'review';
        out.due = new Date(now + intervalDaysForRetention(retention, card.stability) * 86400000).toISOString();
      }
    }
    return out;
  }

  // state === 'review'
  const R = retrievability(elapsedDays, card.stability);
  const Dp = nextDifficulty(card.difficulty, grade);
  if (grade === 1) {
    const Sf = nextStabilityForget(card.difficulty, card.stability, R);
    out.state = 'relearning';
    out.step = 0;
    out.due = new Date(now + RELEARN_STEPS_MIN[0] * 60000).toISOString();
    out.stability = Sf;
    out.difficulty = Dp;
    out.lapses = card.lapses + 1;
  } else {
    const Sr = nextStabilityRecall(card.difficulty, card.stability, R, grade);
    out.state = 'review';
    out.due = new Date(now + intervalDaysForRetention(retention, Sr) * 86400000).toISOString();
    out.stability = Sr;
    out.difficulty = Dp;
  }
  return out;
}

export function formatDelta(dueISO: string, now: number): string {
  const ms = new Date(dueISO).getTime() - now;
  const min = ms / 60000;
  if (min < 60) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h`;
  const day = hr / 24;
  if (day < 30) return `${Math.round(day)}d`;
  const mo = day / 30;
  if (mo < 12) return `${Math.round(mo)}mo`;
  return `${(day / 365).toFixed(1)}y`;
}

/** Preview the "back in ___" delta for all four grades, for the grade-button subtitles. */
export function previewAll(card: Card, retention: number, now?: number): Record<Rating, string> {
  now = now ?? Date.now();
  const out = {} as Record<Rating, string>;
  ([1, 2, 3, 4] as Rating[]).forEach((g) => {
    const r = scheduleCard(card, g, retention, now);
    out[g] = formatDelta(r.due!, now!);
  });
  return out;
}
