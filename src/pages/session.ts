import { commitGrade } from '../lib/cards';
import { fetchDeckStats } from '../lib/decks';
import { previewAll } from '../lib/fsrs';
import { playCardAudio } from '../lib/audioPlayer';
import type { CardFlashcardContent, CardWithNote, Deck, DeckStatsWithStreak, NoteFields, Rating } from '../types';
import { $, esc, errMsg, toast } from '../lib/dom';
import { barRow } from './statsPanel';
import { PROFILES, type ChipAs, type ProfileChip } from '../lib/profiles';
import { computeRevealOutcome, getQuestionText, getRevealAnswerText, pronIconHTML, renderFlashcardDetailHTML, renderReadModeBlock, wirePronunciationIcons, wireReadModeBlock } from '../lib/readModeRenderers';
import { getRenderedPageUrl } from '../lib/pageRender';

export interface SessionDeps {
  onEnd: () => void;
  onSeeAllStats: () => void;
}

const GRADE_META: { n: string; c: string; arrow: string; meaning: string }[] = [
  { n: 'Again', c: 'var(--red)', arrow: '←', meaning: "didn't know it" },
  { n: 'Hard', c: 'var(--amber)', arrow: '↑', meaning: 'knew it, but tough' },
  { n: 'Good', c: 'var(--green)', arrow: '→', meaning: 'normal effort' },
  { n: 'Easy', c: 'var(--indigo)', arrow: '↓', meaning: 'knew it instantly' },
];

/** [dx, dy] unit direction for each grade index (0=Again..3=Easy): left, up, right, down. */
const GRADE_DIR: [number, number][] = [
  [-1, 0],
  [0, -1],
  [1, 0],
  [0, 1],
];

const SWIPE_THRESHOLD = 72;

/**
 * A brief, non-interactive (pointer-events:none) overlay teaching the
 * swipe-to-grade gesture — see `showSwipeHint` in render(). Rather than
 * static arrows, this is an actual demo motion: a translucent ghost card
 * physically slides + rotates to the right (the "Good" direction, the most
 * common grade) with a fingertip dot tracing the same path, mirroring the
 * real fly-off animation grade() plays on an actual swipe.
 */
const SWIPE_HINT_HTML = `
  <div class="swipe-hint" id="swipeHint">
    <div class="sh-ghost"></div>
    <div class="sh-dot"></div>
    <span class="sh-hint-text">Swipe to grade</span>
  </div>`;

/** gi (0-3, matching GRADE_META) for a drag delta, or null if under threshold. */
function swipeGrade(dx: number, dy: number): number | null {
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx < -SWIPE_THRESHOLD) return 0;
    if (dx > SWIPE_THRESHOLD) return 2;
  } else {
    if (dy < -SWIPE_THRESHOLD) return 1;
    if (dy > SWIPE_THRESHOLD) return 3;
  }
  return null;
}

const KEY_GRADE: Record<string, number> = {
  ArrowLeft: 0,
  a: 0,
  ArrowUp: 1,
  w: 1,
  ArrowRight: 2,
  d: 2,
  ArrowDown: 3,
  s: 3,
};

/**
 * Practice session, sub-slice 3: audio player, session-done screen, sidebar.
 * `decks` carries every deck any card in `queue` might belong to — one
 * entry for a normal per-deck session, several for a global "practice
 * everything due" session (see loadQueueAcrossAllDecks) — since each card
 * must be scheduled against its OWN deck's desired_retention, never a
 * single blended value. Returns a cleanup function that must be called when
 * navigating away, to remove the document-level keydown listener.
 */
export function renderSession(container: HTMLElement, decks: Map<string, Deck>, queue: CardWithNote[], deps: SessionDeps): () => void {
  /** The one deck a normal per-deck session belongs to — null for a global, multi-deck session, where there's no single deck to attribute the sidebar/stats to. */
  const singleDeck = decks.size === 1 ? [...decks.values()][0] : null;
  function deckFor(card: CardWithNote): Deck {
    return decks.get(card.deck_id)!;
  }

  let pos = 0;
  let flipped = false;
  /** True once a hasRevealBack generated-other card's Verify comes back correct — grade buttons and the swipe gesture become available on the still-unflipped front, so the learner can swipe it away without tapping Reveal first. Reveal still works normally afterward (flip()'s own guard is untouched) for anyone who wants the fuller back-face detail. Reset alongside `flipped` whenever a new card is shown. */
  let verifiedNoFlip = false;
  let openChipIndex: number | null = null;
  let visibleChips: ProfileChip[] = [];
  const sessRatings: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let deckStats: DeckStatsWithStreak | null = null;
  /** Shown once per session — the first time the first card flips and grading becomes possible — never again after that, even if this card re-renders (e.g. once its page image finishes loading). */
  let swipeHintShown = false;

  // drag state
  let sx = 0;
  let sy = 0;
  let dragging = false;
  let moved = false;

  // Cards with origin='textbook_extraction' carry their source page's
  // rendered_page_path directly — signed URLs for every distinct path in
  // this queue are fetched once up front rather than per card, since
  // createSignedUrl is a network call and the same page image is typically
  // reused by several cards in a row.
  const pageImageUrls = new Map<string, string>();
  void preloadPageImages();
  async function preloadPageImages(): Promise<void> {
    const paths = [...new Set(queue.map((c) => c.import_pages?.rendered_page_path).filter((p): p is string => !!p))];
    if (!paths.length) return;
    try {
      const entries = await Promise.all(paths.map(async (p) => [p, await getRenderedPageUrl(p)] as const));
      for (const [p, url] of entries) pageImageUrls.set(p, url);
      render(); // harmless if the learner already moved past the cards these were for
    } catch {
      // Best-effort — an imported card just renders without its page image if signing fails.
    }
  }

  void loadDeckStats();
  async function loadDeckStats(): Promise<void> {
    try {
      deckStats = await fetchDeckStats(singleDeck?.id ?? null);
    } catch {
      deckStats = null;
    }
    const box = document.getElementById('deckStatsBox');
    if (box) box.outerHTML = deckStatsBoxHTML();
  }

  function sessTotals(): { total: number; acc: number } {
    const r = sessRatings;
    const total = r[1] + r[2] + r[3] + r[4];
    const acc = total ? Math.round(((r[2] + r[3] + r[4]) / total) * 100) : 0;
    return { total, acc };
  }

  function deckStatsBoxHTML(): string {
    const ds = deckStats;
    return `
      <div class="panelbox" id="deckStatsBox">
        <h3>${singleDeck ? esc(singleDeck.name) : 'Your stats'}</h3>
        ${
          ds
            ? `<div class="stat-grid" style="grid-template-columns:1fr 1fr">
          <div class="stat-item"><div class="stat-v">${ds.due.now}</div><div class="stat-k">due now</div></div>
          <div class="stat-item"><div class="stat-v">${ds.cards.new}</div><div class="stat-k">new</div></div>
          <div class="stat-item"><div class="stat-v">${ds.cards.review}</div><div class="stat-k">in review</div></div>
          <div class="stat-item"><div class="stat-v">${ds.due.week}</div><div class="stat-k">due in 7d</div></div>
        </div>`
            : `<p style="font-size:12.5px;color:var(--ink-faint)">Loading...</p>`
        }
      </div>`;
  }

  function sidebarHTML(): string {
    const { total, acc } = sessTotals();
    const r = sessRatings;
    return `
      <aside class="session-sidebar">
        <div class="panelbox">
          <h3>This session</h3>
          <div class="stat-grid" style="grid-template-columns:1fr 1fr">
            <div class="stat-item"><div class="stat-v">${total}</div><div class="stat-k">reviewed</div></div>
            <div class="stat-item"><div class="stat-v">${total ? acc + '%' : '-'}</div><div class="stat-k">accuracy</div></div>
          </div>
          ${
            total
              ? `<div style="margin-top:10px">
            ${barRow('Again', r[1], total, 'var(--red)')}
            ${barRow('Hard', r[2], total, 'var(--amber)')}
            ${barRow('Good', r[3], total, 'var(--green)')}
            ${barRow('Easy', r[4], total, 'var(--indigo)')}
          </div>`
              : `<p style="font-size:12.5px;color:var(--ink-faint);margin-top:6px">Grade your first card to see a breakdown here.</p>`
          }
        </div>
        ${deckStatsBoxHTML()}
      </aside>`;
  }

  /** An imported card's own rendered-block content — goes inside the flip/swipe card exactly like any other card's face. The source page image (when this card's "show source in practice" toggle is on) is deliberately NOT part of this — see sourceImagePaneHTML — so the swipe-to-grade drag only ever moves the small text card, never a full page image alongside it. `showRevealButton` is true only for a generation-mode 'other' card (see revealGeneratedOther) — its Verify button is an optional self-check, never a gate on grading. */
  function importedCardBodyHTML(sourceBlock: CardWithNote, showRevealButton = false): string {
    return `<div class="session-imported-left" data-read-block-id="${esc(sourceBlock.id)}">${renderReadModeBlock(sourceBlock, new Map(), true, showRevealButton)}</div>`;
  }

  /** The source page image for a card with "show source in practice" on, rendered as its own panel beside the flip/swipe card (see session-study-row) rather than inside it — dragging/grading the card never touches this pane. Null when the toggle is off or there's no image (yet). */
  function sourceImagePaneHTML(sourceBlock: CardWithNote): string | null {
    if (!sourceBlock.show_source_in_practice) return null;
    const imagePath = sourceBlock.import_pages?.rendered_page_path ?? null;
    const imageUrl = imagePath ? pageImageUrls.get(imagePath) : null;
    return `<div class="session-source-pane">${imageUrl ? `<img src="${esc(imageUrl)}" alt="Original source">` : '<div class="p-text">Source image not available.</div>'}</div>`;
  }

  function render(): void {
    const total = queue.length;

    if (pos >= total) {
      renderDone();
      return;
    }

    const card = queue[pos];
    // Every generation-mode card (prompt_generated) flips and gets graded —
    // a 'flashcard'-recipe card the classic way (front/back text swap); a
    // non-flashcard recipe (single_choice, matching_pairs, text_input, etc.)
    // shows its interactive widget up front, letting the learner attempt it,
    // then flips to a real back face — question + correct answer only, same
    // mechanics as any other flashcard — whenever there's an actual answer
    // to show (hasRevealBack, gated by getRevealAnswerText the same way the
    // Reveal/Verify buttons are). Without an answer key there's nothing to
    // put on a back face, so that subset falls back to the older in-place
    // reveal (see flip()/revealGeneratedOther below): correct/incorrect
    // marked directly on the same live widget, no real flip. A faithful-
    // extraction card has nothing invented to hide behind a "reveal" step —
    // it always renders already-flipped, straight into grading, exactly as
    // before.
    const isGenerated = card.origin === 'textbook_extraction' && card.prompt_generated;
    const isFlashcard = isGenerated && card.component_type === 'flashcard';
    const isGeneratedOther = isGenerated && !isFlashcard;
    const revealAnswerText = isGeneratedOther ? getRevealAnswerText(card) : null;
    const hasRevealBack = isGeneratedOther && revealAnswerText != null;
    const sourceBlock = card.origin === 'textbook_extraction' && !isGenerated ? card : null;
    const fields = card.fields ?? {};
    const flashcardContent = isFlashcard ? (card.content as CardFlashcardContent) : null;
    const flashcardIpa = flashcardContent?.detail?.ipa ?? null;
    const flashcardDetailHTML = isFlashcard ? renderFlashcardDetailHTML(flashcardContent?.detail) : '';
    const profile = PROFILES[card.note_type ?? 'basic'] ?? PROFILES.basic;
    const front = fields.front || fields.Front || '—';
    const back = fields.back || fields.Back || '—';
    const fcFront = flashcardContent?.front ?? '—';
    const fcBack = flashcardContent?.back ?? '—';
    const isAiWrittenTag = (card.tags || []).includes('generated');
    if (sourceBlock) flipped = true;
    const importedFaceHTML = sourceBlock ? importedCardBodyHTML(sourceBlock) : '';
    const generatedOtherFaceHTML = isGeneratedOther ? importedCardBodyHTML(card, true) : '';
    const generatedOtherQuestion = hasRevealBack ? getQuestionText(card) : '';
    // The source page image (when its own toggle is on) always renders as a panel
    // beside the card, never inside the flip/swipe element itself — see
    // sourceImagePaneHTML's doc comment for why.
    const sourceImageHTML = sourceBlock ? sourceImagePaneHTML(sourceBlock) : isGeneratedOther || isFlashcard ? sourceImagePaneHTML(card) : null;
    // Once per session, the moment grading first becomes possible (first
    // card, flipped) — a brief, non-blocking overlay teaching the swipe
    // gesture. Never shown again after this, even if this same card
    // re-renders for an unrelated reason (e.g. its page image finishing).
    const showSwipeHint = flipped && pos === 0 && !swipeHintShown;
    if (showSwipeHint) swipeHintShown = true;

    container.innerHTML = `
      <div class="session-layout ${sourceBlock || isGeneratedOther ? 'session-layout-wide' : ''}">
        ${sidebarHTML()}
        <div class="session">
          <div class="sess-top">
            <div class="sess-pill"><span class="n">${pos + 1} / ${total}</span><span>${esc(deckFor(card).name)}</span></div>
            <button class="quit" id="endSessionBtn">End session</button>
          </div>
          <div class="sessbar"><span style="width:${Math.round((pos / total) * 100)}%"></span></div>

          <div class="session-study-row">
          <div class="zone" id="zone">
            ${showSwipeHint ? SWIPE_HINT_HTML : ''}
            <div class="verdict" id="verdict"><span id="verdictTxt"></span></div>
            <div class="card ${flipped && !sourceBlock && (!isGeneratedOther || hasRevealBack) ? 'flipped' : ''} ${sourceBlock || isGeneratedOther ? 'session-card-imported' : ''} ${hasRevealBack ? 'session-card-flippable' : ''} ${isFlashcard ? 'pf-card-tall' : ''}" id="card">
              ${
                sourceBlock
                  ? `<div class="face front">${importedFaceHTML}</div>`
                  : isGeneratedOther
                    ? hasRevealBack
                      ? `
              <div class="face front">${generatedOtherFaceHTML}</div>
              <div class="face back">
                <div class="ctype">${esc(card.note_type ?? 'basic')}</div>
                <div class="center">
                  ${generatedOtherQuestion ? `<div class="word small">${esc(generatedOtherQuestion).replace(/\n/g, '<br>')}</div>` : ''}
                  <div class="gloss">${esc(revealAnswerText ?? '').replace(/\n/g, '<br>')}</div>
                </div>
              </div>`
                      : `<div class="face front">${generatedOtherFaceHTML}</div>`
                    : isFlashcard
                      ? `
              <div class="face front">
                <div class="ctype">Flashcard</div>
                <div class="center">
                  <div class="word">${esc(fcFront)}${pronIconHTML(fcFront)}</div>
                  ${flashcardIpa ? `<div class="pf-ipa">/${esc(flashcardIpa)}/</div>` : ''}
                  <div class="prompt"><i class="pulse"></i> Tap the card to reveal</div>
                </div>
              </div>
              <div class="face back pf-rich">
                <div class="ctype">Flashcard</div>
                <div class="center" style="flex:none">
                  <div class="word small">${esc(fcFront)}</div>
                  <div class="gloss">${esc(fcBack)}</div>
                </div>
                ${flashcardDetailHTML}
              </div>`
                    : `
              <div class="face front">
                <div class="ctype">${esc(card.note_type ?? 'basic')}</div>
                ${isAiWrittenTag ? '<div class="gtype">✨ AI-written</div>' : ''}
                <div class="center">
                  <div class="word">${esc(front)}</div>
                  <div class="prompt"><i class="pulse"></i> Tap the card to reveal</div>
                </div>
              </div>
              <div class="face back">
                <div class="ctype">${esc(card.note_type ?? 'basic')}</div>
                ${isAiWrittenTag ? '<div class="gtype">✨ AI-written</div>' : ''}
                <div class="center">
                  <div class="word small">${esc(front)}</div>
                  <div class="gloss">${esc(back)}</div>
                </div>
              </div>`
              }
            </div>
          </div>
          ${sourceImageHTML ?? ''}
          </div>

          <div class="chips" id="chips"></div>
          <div class="panel" id="panel">
            <div class="panel-in">
              <div class="panel-label" id="panelLabel"></div>
              <div id="panelBody"></div>
            </div>
          </div>

          <div class="controls" id="controls">
            ${flipped ? GRADE_ROW_HTML : `<button class="flip-cta" id="flipBtn">Show answer <kbd>space</kbd></button>`}
          </div>
        </div>
      </div>`;

    $(container, '#endSessionBtn').addEventListener('click', deps.onEnd);

    if (flipped) {
      wireGradeButtons(card);
      if (sourceBlock) {
        container.querySelectorAll<HTMLElement>('[data-read-block-id]').forEach((el) => wireReadModeBlock(sourceBlock, el));
      } else if (!isFlashcard && !isGeneratedOther) {
        buildChips(profile.chips, fields);
        if (openChipIndex != null) openPanel(visibleChips[openChipIndex], fields);
      }
    } else {
      $(container, '#flipBtn').addEventListener('click', flip);
    }

    // The interactive widget on the front is wired regardless of flip state
    // — the learner attempts it BEFORE flipping (that's the whole point).
    // For hasRevealBack, flip() just re-renders (a real back face, same as
    // any other flashcard) so this rewires a fresh front on every render;
    // for the in-place fallback, flip() never re-renders (revealGeneratedOther
    // mutates this same live DOM instead, to avoid losing the attempt), so
    // this only ever runs once, pre-flip.
    if (isGeneratedOther) {
      container.querySelectorAll<HTMLElement>('[data-read-block-id]').forEach((el) => wireReadModeBlock(card, el));
      const revealBtn = container.querySelector<HTMLButtonElement>('[data-reveal-block]');
      revealBtn?.addEventListener('click', flip);
      // If the learner checks their own attempt via Verify instead of just
      // hitting Reveal, and it comes back correct, let them swipe the card
      // away right away (added *after* wireReadModeBlock's own verify-click
      // listener above, so this reads the feedback area's class only once
      // Verify has already updated it in the same click). Reveal stays live
      // for anyone who still wants the fuller back-face detail.
      if (revealBtn && hasRevealBack) {
        container.querySelectorAll<HTMLButtonElement>('[data-verify-block]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const area = container.querySelector<HTMLElement>(`[data-feedback-area="${btn.dataset.verifyBlock}"]`);
            if (area?.classList.contains('correct') && !verifiedNoFlip) enableSwipeGrading(card);
          });
        });
      }
    }
    if (isFlashcard) wirePronunciationIcons(container);

    attachInteractions(
      isGeneratedOther && !flipped && !verifiedNoFlip,
      isGeneratedOther && (!hasRevealBack || (!flipped && verifiedNoFlip)),
      isGeneratedOther && !hasRevealBack,
    );
  }

  function renderDone(): void {
    const { total, acc } = sessTotals();
    const r = sessRatings;
    container.innerHTML = `
      <div class="session" style="max-width:600px;margin:0 auto;padding:22px 18px 40px">
        <div class="done">
          <h2>Session complete 🎉</h2>
          <p>${singleDeck ? esc(singleDeck.name) : 'All decks'}</p>
          <div class="stat-grid">
            <div class="stat-item"><div class="stat-v">${total}</div><div class="stat-k">reviewed</div></div>
            <div class="stat-item"><div class="stat-v">${acc}%</div><div class="stat-k">accuracy</div></div>
            <div class="stat-item"><div class="stat-v">🔥 ${deckStats ? deckStats.streak.current : '–'}</div><div class="stat-k">day streak</div></div>
          </div>
          ${
            total
              ? `<div style="max-width:280px;margin:0 auto 20px;text-align:left">
            ${barRow('Again', r[1], total, 'var(--red)')}
            ${barRow('Hard', r[2], total, 'var(--amber)')}
            ${barRow('Good', r[3], total, 'var(--green)')}
            ${barRow('Easy', r[4], total, 'var(--indigo)')}
          </div>`
              : ''
          }
          <div class="row" style="justify-content:center">
            <button id="doneBackBtn">Back</button>
            <button class="btn-sec" id="doneStatsBtn">See all stats</button>
          </div>
        </div>
      </div>`;
    $(container, '#doneBackBtn').addEventListener('click', deps.onEnd);
    $(container, '#doneStatsBtn').addEventListener('click', deps.onSeeAllStats);
  }

  /** One button per grade: swipe-direction arrow + name + plain-language meaning baked right into the button (always visible, no separate legend row to duplicate/repeat it), with the live "back in ___" time as a small corner badge, filled in per-card by wireGradeButtons. */
  function gradeButtonHTML(id: string, cls: string, m: (typeof GRADE_META)[number]): string {
    return `<button class="grade ${cls}" id="${id}"><span class="gname"><span class="garrow">${m.arrow}</span> ${m.n}</span><span class="gmeaning">${esc(m.meaning)}</span><span class="gwhen"></span></button>`;
  }

  const GRADE_ROW_HTML = `
    <div class="grade-row">
      ${gradeButtonHTML('gradeAgain', 'g-again', GRADE_META[0])}
      ${gradeButtonHTML('gradeGood', 'g-good', GRADE_META[2])}
    </div>
    <div class="grade-row">
      ${gradeButtonHTML('gradeHard', 'g-hard', GRADE_META[1])}
      ${gradeButtonHTML('gradeEasy', 'g-easy', GRADE_META[3])}
    </div>`;

  function wireGradeButtons(card: CardWithNote): void {
    const prev = previewAll(card, deckFor(card).desired_retention);
    $<HTMLElement>(container, '#gradeAgain .gwhen').textContent = prev[1];
    $<HTMLElement>(container, '#gradeGood .gwhen').textContent = prev[3];
    $<HTMLElement>(container, '#gradeHard .gwhen').textContent = prev[2];
    $<HTMLElement>(container, '#gradeEasy .gwhen').textContent = prev[4];
    $(container, '#gradeAgain').addEventListener('click', () => void grade(1));
    $(container, '#gradeHard').addEventListener('click', () => void grade(2));
    $(container, '#gradeGood').addEventListener('click', () => void grade(3));
    $(container, '#gradeEasy').addEventListener('click', () => void grade(4));
  }

  /**
   * A non-flashcard generation-mode card's "flip" doesn't swap faces (front
   * and back are the same live interactive widget) — it checks the
   * learner's current attempt in place via the same logic Manage's Verify
   * button uses, then swaps the flip-cta for grade buttons. Deliberately NOT
   * a full render(): that would replace the widget's DOM and lose whatever
   * the learner picked/typed. Also re-enables the swipe/drag gesture
   * (suppressed up to now so dragging the card didn't fight with clicking
   * choice buttons / typing — see attachInteractions) so grading works by
   * swipe here exactly like a flashcard, not just via the grade buttons.
   */
  function revealGeneratedOther(card: CardWithNote): void {
    const el = container.querySelector<HTMLElement>('[data-read-block-id]');
    if (el) {
      const outcome = computeRevealOutcome(card, el);
      const area = el.querySelector<HTMLElement>('[data-feedback-area]');
      if (area && outcome) {
        area.hidden = false;
        area.classList.remove('correct', 'incorrect', 'revealed');
        area.classList.add(outcome.revealed ? 'revealed' : outcome.correct ? 'correct' : 'incorrect');
        area.textContent = outcome.revealed ? outcome.summary : (outcome.correct ? '✓ ' : '✗ ') + outcome.summary;
      }
    }
    const revealBtn = container.querySelector<HTMLButtonElement>('[data-reveal-block]');
    if (revealBtn) revealBtn.disabled = true;
    const controls = document.getElementById('controls');
    if (controls) controls.innerHTML = GRADE_ROW_HTML;
    wireGradeButtons(card);
    attachInteractions(false, true);
  }

  /**
   * A hasRevealBack generated-other card's Verify coming back correct: the
   * learner already knows they got it right without needing the fuller
   * back-face detail, so grade buttons and the swipe gesture become
   * available immediately on the still-unflipped front — same trick as
   * revealGeneratedOther (attachInteractions(false, true), no real face to
   * rotate to yet), but leaves the Reveal button enabled so flip() still
   * works normally for anyone who wants that detail.
   */
  function enableSwipeGrading(card: CardWithNote): void {
    verifiedNoFlip = true;
    const controls = document.getElementById('controls');
    if (controls) controls.innerHTML = GRADE_ROW_HTML;
    wireGradeButtons(card);
    attachInteractions(false, true, false);
  }

  function flip(): void {
    if (flipped) return;
    flipped = true;
    const card = queue[pos];
    const isGeneratedOther = card.origin === 'textbook_extraction' && card.prompt_generated && card.component_type !== 'flashcard';
    const hasRevealBack = isGeneratedOther && getRevealAnswerText(card) != null;
    if (isGeneratedOther && !hasRevealBack) {
      revealGeneratedOther(card);
    } else {
      render();
    }
  }

  /** Grades the current card: fly-off animation, commit via FSRS, then advance. Same path for buttons and swipe. */
  async function grade(g: Rating): Promise<void> {
    const card = queue[pos];
    const gi = g - 1;
    sessRatings[g] += 1;
    const retention = deckFor(card).desired_retention;
    const when = previewAll(card, retention)[g];
    toast(`${GRADE_META[gi].n} — back in ${when}`);

    const [dx, dy] = GRADE_DIR[gi];
    const cardEl = document.getElementById('card');
    if (cardEl) {
      cardEl.style.transition = 'transform .32s cubic-bezier(.4,0,.7,.2), opacity .32s';
      cardEl.style.transform = `translate(${dx * 620}px, ${dy * 520}px) rotate(${dx * 15}deg)`;
      cardEl.style.opacity = '0';
    }

    const commitPromise = commitGrade(card, g, retention).catch((e) => toast('Save failed: ' + errMsg(e)));
    await new Promise((r) => setTimeout(r, 320));
    await commitPromise;

    pos += 1;
    flipped = false;
    verifiedNoFlip = false;
    openChipIndex = null;
    visibleChips = [];
    render();
  }

  // ---------- chips / panel ----------

  function buildChips(chips: ProfileChip[], fields: NoteFields): void {
    const chipsEl = document.getElementById('chips');
    if (!chipsEl) return;
    visibleChips = chips.filter((c) => fields[c.field]);
    const audioCode = (fields.audio || fields.piste) as string | undefined;
    chipsEl.innerHTML =
      (audioCode ? `<button class="chip audio" id="audioChip">🔊 Audio</button>` : '') +
      visibleChips
        .map(
          (c, i) =>
            `<button class="chip chip-text${openChipIndex === i ? ' on' : ''}" data-i="${i}">${esc(c.label)}</button>`,
        )
        .join('');
    if (audioCode) {
      document.getElementById('audioChip')?.addEventListener('click', (e) => {
        playCardAudio(audioCode, e.currentTarget as HTMLElement);
      });
    }
    chipsEl.querySelectorAll<HTMLButtonElement>('.chip-text').forEach((btn) => {
      btn.addEventListener('click', () => onChip(Number(btn.dataset.i), fields));
    });
  }

  function onChip(i: number, fields: NoteFields): void {
    const panel = document.getElementById('panel');
    if (!panel) return;
    if (openChipIndex === i) {
      openChipIndex = null;
      panel.classList.remove('open');
      document.querySelectorAll('.chip-text').forEach((c) => c.classList.remove('on'));
      return;
    }
    openChipIndex = i;
    document.querySelectorAll('.chip-text').forEach((c) => c.classList.remove('on'));
    document.querySelector(`.chip-text[data-i="${i}"]`)?.classList.add('on');
    openPanel(visibleChips[i], fields);
  }

  function openPanel(spec: ProfileChip, fields: NoteFields): void {
    const panel = document.getElementById('panel');
    const label = document.getElementById('panelLabel');
    const body = document.getElementById('panelBody');
    if (!panel || !label || !body) return;
    label.textContent = spec.label;
    body.innerHTML = renderPanelValue(spec.as, fields[spec.field]);
    panel.classList.add('open');
  }

  // ---------- swipe / drag ----------

  /**
   * suppressGesture is true for a non-flashcard generation-mode card: its
   * whole widget is full of real clickable/typeable content (choice
   * buttons, matching items, text inputs), so the usual tap-anywhere /
   * swipe-to-flip-or-grade gesture would swallow those clicks. Only the
   * explicit "Show answer" button and grade buttons work for these —
   * everything else here becomes a no-op.
   */
  /**
   * `singleFace` is true for a non-flashcard generation-mode card with no
   * answer to put on a back face: it has only a `.face.front` (its "reveal"
   * swaps in grade buttons + marks the answer in place, see
   * revealGeneratedOther — there's no `.face.back` to rotate into view). The
   * drag/snap transforms below normally add `rotateY(180deg)` once flipped
   * so the CSS-flipped back face stays facing the viewer while being
   * dragged; doing that here would just rotate the lone front face away
   * from the viewer with nothing behind it, leaving a blank card. singleFace
   * strips that rotation from every transform below.
   *
   * It also means this card's front — the same potentially-long interactive
   * widget the learner was just answering — is still what's on screen after
   * reveal, so it still needs to scroll (see .face's overflow:auto). A
   * flashcard's short, fixed-layout back never needed this, which is why
   * up/down swipes could freely claim every vertical drag for Hard/Easy —
   * here that would swallow the exact gesture the learner needs for
   * scrolling. So for singleFace only, a vertical-dominant drag is left
   * alone entirely (no transform, no preventDefault, no grade) so it falls
   * straight through to native scroll; only a horizontal-dominant drag is
   * ever treated as a swipe.
   */
  function attachInteractions(suppressGesture: boolean, singleFace = false, blockVerticalSwipe = singleFace): void {
    const zone = document.getElementById('zone');
    if (!zone) return;
    const cardEl = document.getElementById('card');
    const flipRotate = singleFace ? '' : 'rotateY(180deg)';

    /** For a still-scrollable singleFace (blockVerticalSwipe), a drag that's currently more vertical than horizontal is a scroll attempt, not a swipe — see attachInteractions' own doc comment. A singleFace card that's already been verified correct (enableSwipeGrading) has nothing left to scroll toward, so it opts out via blockVerticalSwipe=false and gets the full 4-direction swipe like a real flipped card. */
    function isScrollAttempt(dx: number, dy: number): boolean {
      return blockVerticalSwipe && Math.abs(dy) >= Math.abs(dx);
    }

    /**
     * touch-action CSS is just a hint the browser is free to interpret
     * loosely — iOS Safari/Chrome have a long history of still scrolling
     * the page out from under an active pointer drag regardless of it. The
     * one thing that's actually guaranteed to stop it is calling
     * preventDefault() inside a real, non-passive touchmove listener,
     * hence duplicating the pointermove drag logic at the touch-event
     * level purely to hold that veto (addEventListener's touchmove default
     * is passive/uncancelable unless explicitly opted out here).
     *
     * Gated on `flipped` the same way pointermove's own card-drag effect
     * is (dragging becomes true on every touchdown, flipped or not, so
     * without this a card whose front-face content overflows — or an
     * activity card, via suppressGesture — would lose the ability to
     * scroll its own content the moment a finger merely touched it).
     */
    zone.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (suppressGesture || !dragging || (!flipped && !verifiedNoFlip)) return;
        const t = e.touches[0];
        if (t && isScrollAttempt(t.clientX - sx, t.clientY - sy)) return;
        e.preventDefault();
      },
      { passive: false },
    );

    zone.onpointerdown = (e: PointerEvent) => {
      if (suppressGesture) return;
      if ((e.target as HTMLElement | null)?.closest('.chip, .pron-icon')) return;
      sx = e.clientX;
      sy = e.clientY;
      dragging = true;
      moved = false;
      const c = document.getElementById('card');
      if (c) c.classList.add('dragging');
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    zone.onpointermove = (e: PointerEvent) => {
      if (suppressGesture) return;
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (!flipped && !verifiedNoFlip) return;
      if (isScrollAttempt(dx, dy)) return;
      const c = document.getElementById('card');
      const v = document.getElementById('verdict');
      if (!c || !v) return;
      c.style.transform = `translate(${dx}px, ${Math.min(dy, 90)}px) rotate(${dx * 0.045}deg) ${flipRotate}`;
      const g = swipeGrade(dx, dy);
      if (g === null) {
        v.style.opacity = '0';
      } else {
        v.style.opacity = String(Math.min(1, (Math.max(Math.abs(dx), Math.abs(dy)) - 40) / 60));
        v.style.background = 'color-mix(in srgb, ' + GRADE_META[g].c + ' 16%, transparent)';
        const txt = document.getElementById('verdictTxt');
        if (txt) {
          txt.textContent = GRADE_META[g].n;
          txt.style.background = GRADE_META[g].c;
        }
      }
    };

    /**
     * A cancelled gesture (browser-initiated scroll takeover, system
     * gesture, multi-touch, etc. — common on mobile) is never a completed
     * swipe: it must always just snap the card back, never grade or flip.
     */
    function endDrag(e: PointerEvent, cancelled = false): void {
      if (suppressGesture) return;
      if (!dragging) return;
      dragging = false;
      const c = document.getElementById('card');
      const v = document.getElementById('verdict');
      if (c) c.classList.remove('dragging');
      if (v) v.style.opacity = '0';
      if (cancelled) {
        if (c) c.style.transform = flipped ? flipRotate : '';
        return;
      }
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && !flipped && !verifiedNoFlip) {
        flip();
        return;
      }
      if (!flipped && !verifiedNoFlip) {
        if (c) c.style.transform = '';
        return;
      }
      if (isScrollAttempt(dx, dy)) return;
      const g = swipeGrade(dx, dy);
      if (g !== null) void grade((g + 1) as Rating);
      else if (c) c.style.transform = flipRotate;
    }
    zone.onpointerup = (e) => endDrag(e);
    zone.onpointercancel = (e) => endDrag(e, true);

    if (cardEl) {
      cardEl.onclick = (e: MouseEvent) => {
        if (suppressGesture) return;
        if ((e.target as HTMLElement | null)?.closest('.chip, .pron-icon') || moved) return;
        if (!flipped && !verifiedNoFlip) flip();
      };
    }
  }

  // ---------- keyboard ----------

  function onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    const panel = document.getElementById('panel');
    const inPanel = !!panel && (panel.contains(document.activeElement) || panel.matches(':hover'));

    if (e.code === 'Space' || e.key === 'Enter') {
      if (inPanel && e.code === 'Space') return;
      e.preventDefault();
      if (!flipped) flip();
      return;
    }

    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k in KEY_GRADE && (flipped || verifiedNoFlip) && !inPanel) {
      e.preventDefault();
      void grade((KEY_GRADE[k] + 1) as Rating);
      return;
    }

    if (['1', '2', '3', '4'].includes(e.key)) {
      const chips = [...document.querySelectorAll<HTMLButtonElement>('#chips .chip-text')];
      chips[+e.key - 1]?.click();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  render();

  return () => document.removeEventListener('keydown', onKeyDown);
}

interface ExamplePairLike {
  fr: string;
  en: string;
  source?: string;
}

function renderPanelValue(as: ChipAs | undefined, val: unknown): string {
  if (as === 'list' && Array.isArray(val)) {
    return `<div class="p-text">${(val as unknown[]).map((v) => esc(v)).join('<br>')}</div>`;
  }
  if (as === 'examples' && Array.isArray(val)) {
    const items: ExamplePairLike[] = typeof val[0] === 'string' ? [{ fr: val[0], en: val[1] }] : val;
    return items
      .map((ex) => {
        const isGen = ex.source === 'generated';
        return `<div class="p-pair${isGen ? ' generated' : ''}">
          <div class="fr">${esc(ex.fr)}${isGen ? '<span class="gen-badge">AI-written</span>' : ''}</div>
          <div class="en">${esc(ex.en)}</div>
        </div>`;
      })
      .join('');
  }
  if (as === 'table' && Array.isArray(val)) {
    const rows = (val as unknown[][])
      .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
      .join('');
    return `<table class="p-tbl">${rows}</table>`;
  }
  if (as === 'pair' && Array.isArray(val)) {
    return `<div class="p-pair"><div class="fr">${esc(val[0])}</div><div class="en">${esc(val[1])}</div></div>`;
  }
  if (Array.isArray(val)) {
    if (val.length === 2) return renderPanelValue('pair', val);
    return `<div class="p-text">${val.map((v) => esc(v)).join('<br>')}</div>`;
  }
  return `<div class="p-text">${esc(val)}</div>`;
}
