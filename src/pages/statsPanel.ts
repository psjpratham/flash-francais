import type { DeckStats, RatingCounts } from '../types';
import { esc } from '../lib/dom';

export function totalOf(r: RatingCounts): number {
  return r.again + r.hard + r.good + r.easy;
}

export function accuracyPct(r: RatingCounts): number {
  const total = totalOf(r);
  return total ? Math.round(((r.good + r.easy + r.hard) / total) * 100) : 0;
}

export function barRow(label: string, count: number, total: number, color: string): string {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return `<div class="barrow">
    <span class="lbl">${esc(label)}</span>
    <span class="bar"><span style="width:${pct}%;background:${color}"></span></span>
    <span class="val">${count}</span>
  </div>`;
}

/** The "+ More stats" expansion: card states, all-time history, memory model. Shared by library + deck pages. */
export function statsMoreHTML(data: DeckStats): string {
  const totalReviews = totalOf(data.ratingsAll);
  const accAll = accuracyPct(data.ratingsAll);
  return `
    <div class="panelbox">
      <h3>Card states</h3>
      <div style="max-width:420px">
        ${barRow('New', data.cards.new, data.cards.total, 'var(--indigo)')}
        ${barRow('Learning', data.cards.learning, data.cards.total, 'var(--amber)')}
        ${barRow('Review', data.cards.review, data.cards.total, 'var(--green)')}
        ${barRow('Relearning', data.cards.relearning, data.cards.total, 'var(--red)')}
      </div>
      <p style="font-size:12.5px;color:var(--ink-faint);margin-top:8px">${data.cards.total} cards total</p>
    </div>

    <div class="panelbox">
      <h3>All-time review history</h3>
      <div class="stat-grid">
        <div class="stat-item"><div class="stat-v">${data.reviews.all}</div><div class="stat-k">total reviews</div></div>
        <div class="stat-item"><div class="stat-v">${data.reviews.week}</div><div class="stat-k">last 7 days</div></div>
        <div class="stat-item"><div class="stat-v">${accAll}%</div><div class="stat-k">all-time accuracy</div></div>
      </div>
      <p style="font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-faint);margin:14px 0 9px">Grade breakdown (all-time)</p>
      <div style="max-width:420px">
        ${barRow('Again', data.ratingsAll.again, totalReviews, 'var(--red)')}
        ${barRow('Hard', data.ratingsAll.hard, totalReviews, 'var(--amber)')}
        ${barRow('Good', data.ratingsAll.good, totalReviews, 'var(--green)')}
        ${barRow('Easy', data.ratingsAll.easy, totalReviews, 'var(--indigo)')}
      </div>
    </div>

    <div class="panelbox">
      <h3>Memory model</h3>
      <div class="stat-grid">
        <div class="stat-item"><div class="stat-v">${data.avgStability != null ? data.avgStability.toFixed(1) : '–'}</div><div class="stat-k">avg stability (days)</div></div>
        <div class="stat-item"><div class="stat-v">${data.avgDifficulty != null ? data.avgDifficulty.toFixed(1) : '–'}</div><div class="stat-k">avg difficulty (1–10)</div></div>
      </div>
      <p style="font-size:12.5px;color:var(--ink-faint)">Averaged across cards currently in the Review state. Higher stability means longer gaps between reviews; higher difficulty means the card fights the forgetting curve harder.</p>
    </div>
  `;
}
