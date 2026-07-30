import { commitGrade } from '../lib/cards';
import { fetchDeckStats } from '../lib/decks';
import { previewAll } from '../lib/fsrs';
import { playCardAudio } from '../lib/audioPlayer';
import type { CardFlashcardContent, CardWithNote, Deck, DeckStatsWithStreak, NoteFields, Rating } from '../types';
import { $, esc, errMsg, toast } from '../lib/dom';
import { barRow } from './statsPanel';
import { PROFILES, type ChipAs, type ProfileChip } from '../lib/profiles';
import { computeVerifyOutcome, pronIconHTML, renderFlashcardDetailHTML, renderReadModeBlock, wirePronunciationIcons, wireReadModeBlock } from '../lib/readModeRenderers';
import { getRenderedPageUrl } from '../lib/pageRender';

export interface SessionDeps {
  onEnd: () => void;
  onSeeAllStats: () => void;
}

const GRADE_META: { n: string; c: string }[] = [
  { n: 'Again', c: 'var(--red)' },
  { n: 'Hard', c: 'var(--amber)' },
  { n: 'Good', c: 'var(--green)' },
  { n: 'Easy', c: 'var(--indigo)' },
];

/** [dx, dy] unit direction for each grade index (0=Again..3=Easy): left, up, right, down. */
const GRADE_DIR: [number, number][] = [
  [-1, 0],
  [0, -1],
  [1, 0],
  [0, 1],
];

const SWIPE_THRESHOLD = 72;

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
  let openChipIndex: number | null = null;
  let visibleChips: ProfileChip[] = [];
  const sessRatings: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let deckStats: DeckStatsWithStreak | null = null;

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

  /** The same split page-image + rendered-card layout the admin review UI uses, reused here so an imported card studies exactly like it reads — but only when this card's own "show source in practice" toggle is on; otherwise it's just the card content, full width. */
  function importedCardBodyHTML(sourceBlock: CardWithNote): string {
    const content = `<div class="session-imported-left" data-read-block-id="${esc(sourceBlock.id)}">${renderReadModeBlock(sourceBlock, new Map(), true)}</div>`;
    if (!sourceBlock.show_source_in_practice) {
      return `<div class="session-imported-split session-imported-solo">${content}</div>`;
    }
    const imagePath = sourceBlock.import_pages?.rendered_page_path ?? null;
    const imageUrl = imagePath ? pageImageUrls.get(imagePath) : null;
    return `
      <div class="session-imported-split">
        ${content}
        <div class="session-imported-right">
          ${imageUrl ? `<img src="${esc(imageUrl)}" alt="Original source">` : '<div class="p-text">Source image not available.</div>'}
        </div>
      </div>`;
  }

  function render(): void {
    const total = queue.length;

    if (pos >= total) {
      renderDone();
      return;
    }

    const card = queue[pos];
    // Every generation-mode card (prompt_generated) flips and gets graded —
    // a 'flashcard'-recipe card the classic way (front/back text swap); any
    // other recipe (single_choice, matching_pairs, text_input, etc.) by
    // showing its interactive widget up front, letting the learner attempt
    // it, then revealing correct/incorrect in place on "Show answer" (see
    // flip()/revealGeneratedOther below) before grading. A faithful-
    // extraction card has nothing invented to hide behind a "reveal" step —
    // it always renders already-flipped, straight into grading, exactly as
    // before.
    const isGenerated = card.origin === 'textbook_extraction' && card.prompt_generated;
    const isFlashcard = isGenerated && card.component_type === 'flashcard';
    const isGeneratedOther = isGenerated && !isFlashcard;
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
    const generatedOtherFaceHTML = isGeneratedOther ? importedCardBodyHTML(card) : '';

    container.innerHTML = `
      <div class="session-layout ${sourceBlock || isGeneratedOther ? 'session-layout-wide' : ''}">
        ${sidebarHTML()}
        <div class="session">
          <div class="sess-top">
            <div class="sess-pill"><span class="n">${pos + 1} / ${total}</span><span>${esc(deckFor(card).name)}</span></div>
            <button class="quit" id="endSessionBtn">End session</button>
          </div>
          <div class="sessbar"><span style="width:${Math.round((pos / total) * 100)}%"></span></div>

          <div class="zone" id="zone">
            <div class="verdict" id="verdict"><span id="verdictTxt"></span></div>
            <div class="card ${flipped ? 'flipped' : ''} ${sourceBlock || isGeneratedOther ? 'session-card-imported' : ''} ${isFlashcard ? 'pf-card-tall' : ''}" id="card">
              ${
                sourceBlock
                  ? `<div class="face front">${importedFaceHTML}</div><div class="face back">${importedFaceHTML}</div>`
                  : isGeneratedOther
                    ? `<div class="face front">${generatedOtherFaceHTML}</div>`
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

          <div class="chips" id="chips"></div>
          <div class="panel" id="panel">
            <div class="panel-in">
              <div class="panel-label" id="panelLabel"></div>
              <div id="panelBody"></div>
            </div>
          </div>

          <div class="controls" id="controls">
            ${
              flipped
                ? `
              <div class="grade-row">
                <button class="grade g-again" id="gradeAgain"><span class="gname">Again</span><span class="gwhen"></span></button>
                <button class="grade g-good" id="gradeGood"><span class="gname">Good</span><span class="gwhen"></span></button>
              </div>
              <div class="grade-row">
                <button class="grade g-hard" id="gradeHard"><span class="gname">Hard</span><span class="gwhen"></span></button>
                <button class="grade g-easy" id="gradeEasy"><span class="gname">Easy</span><span class="gwhen"></span></button>
              </div>
              <div class="legend"><span>← Again</span><span>↑ Hard</span><span>→ Good</span><span>↓ Easy</span></div>
            `
                : `<button class="flip-cta" id="flipBtn">Show answer <kbd>space</kbd></button>`
            }
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

    // The interactive widget itself is wired regardless of flip state — the
    // learner attempts it BEFORE flipping (that's the whole point), and
    // flip() reveals correct/incorrect on this same live DOM rather than
    // re-rendering, so wiring only needs to happen once, here.
    if (isGeneratedOther) {
      container.querySelectorAll<HTMLElement>('[data-read-block-id]').forEach((el) => wireReadModeBlock(card, el));
    }
    if (isFlashcard) wirePronunciationIcons(container);

    attachInteractions(isGeneratedOther);
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

  const GRADE_ROW_HTML = `
    <div class="grade-row">
      <button class="grade g-again" id="gradeAgain"><span class="gname">Again</span><span class="gwhen"></span></button>
      <button class="grade g-good" id="gradeGood"><span class="gname">Good</span><span class="gwhen"></span></button>
    </div>
    <div class="grade-row">
      <button class="grade g-hard" id="gradeHard"><span class="gname">Hard</span><span class="gwhen"></span></button>
      <button class="grade g-easy" id="gradeEasy"><span class="gname">Easy</span><span class="gwhen"></span></button>
    </div>
    <div class="legend"><span>← Again</span><span>↑ Hard</span><span>→ Good</span><span>↓ Easy</span></div>`;

  /**
   * A non-flashcard generation-mode card's "flip" doesn't swap faces (front
   * and back are the same live interactive widget) — it checks the
   * learner's current attempt in place via the same logic Manage's Verify
   * button uses, then swaps the flip-cta for grade buttons. Deliberately NOT
   * a full render(): that would replace the widget's DOM and lose whatever
   * the learner picked/typed.
   */
  function revealGeneratedOther(card: CardWithNote): void {
    const el = container.querySelector<HTMLElement>('[data-read-block-id]');
    if (el) computeVerifyOutcome(card, el);
    const controls = document.getElementById('controls');
    if (controls) controls.innerHTML = GRADE_ROW_HTML;
    wireGradeButtons(card);
  }

  function flip(): void {
    if (flipped) return;
    flipped = true;
    const card = queue[pos];
    const isGeneratedOther = card.origin === 'textbook_extraction' && card.prompt_generated && card.component_type !== 'flashcard';
    if (isGeneratedOther) {
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
  function attachInteractions(suppressGesture: boolean): void {
    const zone = document.getElementById('zone');
    if (!zone) return;
    const cardEl = document.getElementById('card');

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
      if (!flipped) return;
      const c = document.getElementById('card');
      const v = document.getElementById('verdict');
      if (!c || !v) return;
      c.style.transform = `translate(${dx}px, ${Math.min(dy, 90)}px) rotate(${dx * 0.045}deg) rotateY(180deg)`;
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

    function endDrag(e: PointerEvent): void {
      if (suppressGesture) return;
      if (!dragging) return;
      dragging = false;
      const c = document.getElementById('card');
      const v = document.getElementById('verdict');
      if (c) c.classList.remove('dragging');
      if (v) v.style.opacity = '0';
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && !flipped) {
        flip();
        return;
      }
      if (!flipped) {
        if (c) c.style.transform = '';
        return;
      }
      const g = swipeGrade(dx, dy);
      if (g !== null) void grade((g + 1) as Rating);
      else if (c) c.style.transform = 'rotateY(180deg)';
    }
    zone.onpointerup = endDrag;
    zone.onpointercancel = endDrag;

    if (cardEl) {
      cardEl.onclick = (e: MouseEvent) => {
        if (suppressGesture) return;
        if ((e.target as HTMLElement | null)?.closest('.chip, .pron-icon') || moved) return;
        if (!flipped) flip();
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
    if (k in KEY_GRADE && flipped && !inPanel) {
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
