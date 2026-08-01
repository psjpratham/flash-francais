// Study mode: walk one or more stacks' cards in order — no FSRS, no due
// dates, no grading, nothing written to review_log. Purely "read this
// content front to back," the way you'd flip through a printed page or a
// stack of index cards. Practice mode (session.ts) is the opposite:
// FSRS-scheduled, deliberately unfilterable. Study is where selection
// lives instead — one or several stacks (chosen on the Stacks browser),
// optionally narrowed by tag within that selection.

import { clearStudyAnswersForCards, listCardsForStacks, updateCardStudyAnswer } from '../lib/pageExtractions';
import { getStackById } from '../lib/stacks';
import { getRenderedPageUrl } from '../lib/pageRender';
import { applyAnswerState, computeRevealOutcome, pronIconHTML, renderFlashcardDetailHTML, renderReadModeBlock, wireAnswerCapture, wirePronunciationIcons, wireReadModeBlock } from '../lib/readModeRenderers';
import type { CardFlashcardContent, CardWithNote } from '../types';
import { $, confirmDialog, errMsg, esc } from '../lib/dom';

const STUDY_ANSWER_SAVE_DEBOUNCE_MS = 400;

/** Only a generation-mode 'flashcard'-recipe card gets the pure flip UI (see flashcardFace) — a faithful extraction that merely happens to use the flashcard recipe (e.g. a vocabulary card) has nothing invented to hide behind a flip, and needs importedFace's source-image handling, same distinction session.ts's isFlashcard already makes. */
function isFlashcardCard(card: CardWithNote): boolean {
  return card.origin === 'textbook_extraction' && card.prompt_generated && card.component_type === 'flashcard';
}

export interface StudyModeDeps {
  onBack: () => void;
  stackIds: string[];
  /** Narrows cards within the selected stack(s) — Study's equivalent of the old deck-wide Practice tag filter, scoped to the selection instead. */
  tagFilter: string[];
  /** How many tiles the learner actually picked on the Study picker — the header's "N stacks" must echo this, not stackIds.length. A single import tile picked there can expand to many underlying per-page `stacks` rows (one per page), so stackIds.length routinely runs way ahead of what was actually clicked — see StudyPickerDeps.onStudySelected. */
  tileCount: number;
}

/** One entry per selected stack that actually contributed a card (a tag filter can empty one out entirely) — `cards` is already sorted stack-by-stack (see listCardsForStacks), so each group is a contiguous run starting at `startIndex`. Powers the page-nav strip, same idea as pageReview.ts's own Prev/Next-page-of-this-import bar, just one level up: jumping between stacks instead of between pages within one. */
interface StudyPageGroup {
  name: string;
  startIndex: number;
}

export async function renderStudyMode(container: HTMLElement, deps: StudyModeDeps): Promise<void> {
  let cards: CardWithNote[] = [];
  let title = '';
  let pageGroups: StudyPageGroup[] = [];
  // Per-card source image, not one shared image — a multi-stack study walk can cross several different source pages, each with its own image.
  const pageImageUrls = new Map<string, string>();
  let pos = 0;
  let flipped = false; // manual/flashcard cards only, always starts false on a new card — a page-stack card has nothing to hide, see importedFace()
  let ready = false;
  let loadError: string | null = null;

  // ---------- persisted in-progress answers (see readModeRenderers.ts's
  // captureAnswerState/applyAnswerState) — debounced per-card so rapid
  // typing doesn't fire a save per keystroke, with an immediate flush before
  // leaving a card so nothing recent is ever lost to an in-flight timer. ----------
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingAnswerStates = new Map<string, Record<string, unknown> | null>();

  function scheduleAnswerSave(cardId: string, state: Record<string, unknown> | null): void {
    const card = cards.find((c) => c.id === cardId);
    if (card) card.study_answer = state; // keep in-memory copy fresh so navigating back to this card restores it even before the debounced save lands
    pendingAnswerStates.set(cardId, state);
    const existing = saveTimers.get(cardId);
    if (existing) clearTimeout(existing);
    saveTimers.set(
      cardId,
      setTimeout(() => flushAnswerSave(cardId), STUDY_ANSWER_SAVE_DEBOUNCE_MS),
    );
  }

  function flushAnswerSave(cardId: string): void {
    const timer = saveTimers.get(cardId);
    if (timer) clearTimeout(timer);
    saveTimers.delete(cardId);
    if (!pendingAnswerStates.has(cardId)) return;
    const state = pendingAnswerStates.get(cardId) ?? null;
    pendingAnswerStates.delete(cardId);
    void updateCardStudyAnswer(cardId, state).catch(() => {
      // Best-effort — a failed save just means this answer isn't backed up yet; never blocks the learner.
    });
  }

  function flushAllAnswerSaves(): void {
    for (const cardId of [...saveTimers.keys()]) flushAnswerSave(cardId);
  }

  async function load(): Promise<void> {
    try {
      const [stackInfos, stackCards] = await Promise.all([
        Promise.all(deps.stackIds.map((id) => getStackById(id))),
        listCardsForStacks(deps.stackIds, deps.tagFilter),
      ]);
      title = stackInfos.length === 1 ? stackInfos[0].name : `${deps.tileCount} stack${deps.tileCount === 1 ? '' : 's'}`;
      cards = stackCards;
      const nameByStackId = new Map(stackInfos.map((s) => [s.id, s.name]));
      pageGroups = deps.stackIds
        .map((id) => ({ name: nameByStackId.get(id) ?? '—', startIndex: cards.findIndex((c) => c.stack_id === id) }))
        .filter((g) => g.startIndex !== -1);

      const cardsWithSavedAnswers = cards.filter((c) => c.study_answer != null);
      if (cardsWithSavedAnswers.length && (await confirmDialog('You have saved answers from a previous Study session. Clear them before studying?'))) {
        await clearStudyAnswersForCards(cardsWithSavedAnswers.map((c) => c.id));
        for (const c of cardsWithSavedAnswers) c.study_answer = null;
      }

      const paths = [...new Set(cards.map((c) => c.import_pages?.rendered_page_path).filter((p): p is string => !!p))];
      await Promise.all(
        paths.map(async (p) => {
          try {
            pageImageUrls.set(p, await getRenderedPageUrl(p));
          } catch {
            // best-effort — that card's face just renders without its source image
          }
        }),
      );
    } catch (e) {
      loadError = errMsg(e);
    }
    ready = true;
    render();
  }

  function shell(inner: string): void {
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← Stacks</button>
        ${inner}
      </div>`;
    $(container, '#backBtn').addEventListener('click', () => {
      flushAllAnswerSaves();
      deps.onBack();
    });
  }

  function render(): void {
    if (!ready) return shell(`<div class="stats-loading">Loading…</div>`);
    if (loadError) return shell(`<div class="panelbox">Could not load these stacks: ${esc(loadError)}</div>`);
    if (!cards.length) return shell(`<div class="panelbox"><p class="p-text">No cards match this selection.</p></div>`);
    if (pos >= cards.length) return renderDone();

    const total = cards.length;
    const card = cards[pos];
    shell(`
      <div class="study-top">
        <span class="sess-pill"><span class="n">${pos + 1} / ${total}</span><span>${esc(title)}</span></span>
      </div>
      <div class="sessbar"><span style="width:${Math.round((pos / total) * 100)}%"></span></div>
      ${renderPageNav()}
      <div class="row" style="justify-content:center;margin-bottom:14px" id="studyControlsTop"></div>
      <div id="studyCardArea">${cardHTML(card)}</div>
      <div class="row" style="justify-content:center;margin-top:16px" id="studyControls"></div>
    `);
    wireCard(card);
    renderControls();
    wirePageNav();
  }

  /** Which selected stack `pos` currently sits inside — pageGroups is ordered and each group's cards are contiguous, so the last group whose startIndex is at-or-before pos is the current one. */
  function currentPageIndex(): number {
    let idx = 0;
    for (let i = pageGroups.length - 1; i >= 0; i--) {
      if (pos >= pageGroups[i].startIndex) {
        idx = i;
        break;
      }
    }
    return idx;
  }

  function goToPage(i: number): void {
    if (i < 0 || i >= pageGroups.length) return;
    flushAllAnswerSaves();
    pos = pageGroups[i].startIndex;
    flipped = false;
    render();
  }

  /** Prev/Next + jump strip across the selected stacks — same layout/classes as pageReview.ts's own page-nav, one level up: jumping between whole stacks instead of between pages within one. Omitted for a single-stack study walk, where there's nothing to navigate. */
  function renderPageNav(): string {
    if (pageGroups.length <= 1) return '';
    const idx = currentPageIndex();
    return `
      <div class="page-nav">
        <button class="btn-sec" id="prevPageBtn" ${idx === 0 ? 'disabled' : ''}>← Prev page</button>
        <div class="page-nav-strip">
          <span class="page-nav-label">Page ${idx + 1} of ${pageGroups.length}</span>
          <div class="page-nav-dots">${pageGroups.map((g, i) => `<button class="page-thumb ${i === idx ? 'on' : ''}" data-goto-page="${i}" title="${esc(g.name)}">${i + 1}</button>`).join('')}</div>
        </div>
        <button class="btn-sec" id="nextPageBtn" ${idx === pageGroups.length - 1 ? 'disabled' : ''}>Next page →</button>
      </div>`;
  }

  function wirePageNav(): void {
    if (pageGroups.length <= 1) return;
    const idx = currentPageIndex();
    document.getElementById('prevPageBtn')?.addEventListener('click', () => goToPage(idx - 1));
    document.getElementById('nextPageBtn')?.addEventListener('click', () => goToPage(idx + 1));
    document.querySelectorAll<HTMLButtonElement>('[data-goto-page]').forEach((btn) => {
      btn.addEventListener('click', () => goToPage(Number(btn.dataset.gotoPage)));
    });
  }

  /** Page-stack cards render read-only (nothing to guess, so nothing to flip) in the same split page-image view the review UI and practice session both use — studying one reads exactly like reviewing it. The source pane only shows when this card's own "show source in study mode" toggle is on — independent of its Practice-mode counterpart. */
  function importedFace(card: CardWithNote): string {
    const content = `<div class="session-imported-left" data-read-block-id="${esc(card.id)}">${renderReadModeBlock(card, new Map(), true, true)}</div>`;
    const imagePath = card.import_pages?.rendered_page_path ?? null;
    const imageUrl = card.show_source_in_study && imagePath ? pageImageUrls.get(imagePath) : null;
    if (!imageUrl) {
      return `<div class="panelbox" style="padding:0;overflow:hidden">
        <div class="session-imported-split session-imported-solo" style="min-height:480px">${content}</div>
      </div>`;
    }
    return `
      <div class="panelbox" style="padding:0;overflow:hidden">
        <div class="session-imported-split" style="min-height:480px">
          ${content}
          <div class="session-imported-right">
            <img src="${esc(imageUrl)}" alt="Original source">
          </div>
        </div>
      </div>`;
  }

  /** Manual cards keep a tap-to-reveal flip, same visual language as practice mode — just no grading afterward, only Next. */
  function manualFace(card: CardWithNote): string {
    const fields = card.fields ?? {};
    const front = fields.front || fields.Front || '—';
    const back = fields.back || fields.Back || '—';
    return `
      <div class="zone" id="studyFlipZone">
        <div class="card ${flipped ? 'flipped' : ''}" id="studyFlipCard">
          <div class="face front"><div class="center"><div class="word">${esc(front)}</div><div class="prompt"><i class="pulse"></i> Tap to reveal</div></div></div>
          <div class="face back"><div class="center"><div class="word small">${esc(front)}</div><div class="gloss">${esc(back)}</div></div></div>
        </div>
      </div>`;
  }

  /** A generated card's source page image, when its own "show source in study mode" toggle is on — rendered as a panel beside the flip card (see session-study-row/session-source-pane, shared with Practice mode's own version of this), never inside the flipping element itself. Null when the toggle is off or there's no image (yet). */
  function sourceImagePaneHTML(card: CardWithNote): string | null {
    if (!card.show_source_in_study) return null;
    const imagePath = card.import_pages?.rendered_page_path ?? null;
    const imageUrl = imagePath ? pageImageUrls.get(imagePath) : null;
    if (!imageUrl) return null;
    return `<div class="session-source-pane"><img src="${esc(imageUrl)}" alt="Original source"></div>`;
  }

  /** A 'flashcard'-recipe card — same tap-to-flip mental model as every other card here and Practice mode, front first. The back shows its rich detail (examples especially) directly, never gated behind a further click. */
  function flashcardFace(card: CardWithNote): string {
    const content = card.content as CardFlashcardContent;
    const front = content.front ?? '—';
    const back = content.back ?? '—';
    const ipa = content.detail?.ipa;
    const detailHTML = renderFlashcardDetailHTML(content.detail);
    const cardZoneHTML = `
      <div class="zone" id="studyFlashcardZone">
        <div class="card pf-card-tall ${flipped ? 'flipped' : ''}" id="studyFlashcard">
          <div class="face front"><div class="center"><div class="word">${esc(front)}${pronIconHTML(front)}</div>${ipa ? `<div class="pf-ipa">/${esc(ipa)}/</div>` : ''}<div class="prompt"><i class="pulse"></i> Tap to reveal</div></div></div>
          <div class="face back pf-rich"><div class="center" style="flex:none"><div class="word small">${esc(front)}</div><div class="gloss">${esc(back)}</div></div>${detailHTML}</div>
        </div>
      </div>`;
    const imagePane = sourceImagePaneHTML(card);
    return imagePane ? `<div class="session-study-row">${cardZoneHTML}${imagePane}</div>` : cardZoneHTML;
  }

  function cardHTML(card: CardWithNote): string {
    if (isFlashcardCard(card)) return flashcardFace(card);
    return card.origin === 'textbook_extraction' ? importedFace(card) : manualFace(card);
  }

  /** Reveal is a plain self-check here — Study mode has no grading to gate, so it never disables/swaps controls like Practice's revealGeneratedOther does; it just shows the answer in the same feedback area Verify uses. */
  function wireRevealButton(card: CardWithNote, el: HTMLElement): void {
    el.querySelector<HTMLButtonElement>('[data-reveal-block]')?.addEventListener('click', () => {
      const outcome = computeRevealOutcome(card, el);
      const area = el.querySelector<HTMLElement>('[data-feedback-area]');
      if (!area || !outcome) return;
      area.hidden = false;
      area.classList.remove('correct', 'incorrect', 'revealed');
      area.classList.add(outcome.revealed ? 'revealed' : outcome.correct ? 'correct' : 'incorrect');
      area.textContent = outcome.revealed ? outcome.summary : (outcome.correct ? '✓ ' : '✗ ') + outcome.summary;
    });
  }

  function wireCard(card: CardWithNote): void {
    if (isFlashcardCard(card)) {
      const el = document.getElementById('studyFlashcard');
      if (el) {
        wirePronunciationIcons(el);
        el.addEventListener('click', (e) => {
          if ((e.target as HTMLElement | null)?.closest('.pron-icon')) return;
          flipped = !flipped;
          render();
        });
      }
      return;
    }
    if (card.origin === 'textbook_extraction') {
      const el = container.querySelector<HTMLElement>('[data-read-block-id]');
      if (el) {
        wireReadModeBlock(card, el);
        applyAnswerState(card, el, card.study_answer);
        wireAnswerCapture(card, el, (state) => scheduleAnswerSave(card.id, state));
        wireRevealButton(card, el);
      }
      return;
    }
    document.getElementById('studyFlipCard')?.addEventListener('click', () => {
      flipped = !flipped;
      render();
    });
  }

  function goPrev(): void {
    flushAllAnswerSaves();
    pos = Math.max(0, pos - 1);
    flipped = false;
    render();
  }

  function goNext(): void {
    flushAllAnswerSaves();
    pos += 1;
    flipped = false;
    render();
  }

  /** Prev/Next appear both above and below the card — a long imported card's controls can otherwise scroll out of view, so the top pair is a duplicate for reachability without scrolling back up. */
  function renderControls(): void {
    const controlsHTML = `
      <button class="btn-sec" data-study-prev ${pos === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="btn-primary" style="width:auto" data-study-next>${pos === cards.length - 1 ? 'Finish' : 'Next →'}</button>`;
    ['studyControlsTop', 'studyControls'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = controlsHTML;
      el.querySelector('[data-study-prev]')?.addEventListener('click', goPrev);
      el.querySelector('[data-study-next]')?.addEventListener('click', goNext);
    });
  }

  function renderDone(): void {
    shell(`
      <div class="panelbox" style="max-width:420px;margin:40px auto;text-align:center">
        <h2 style="font-family:'IBM Plex Serif',serif;margin-bottom:8px">Nice work! 🎉</h2>
        <p style="color:var(--ink-soft);margin-bottom:16px">You've been through all ${cards.length} card${cards.length === 1 ? '' : 's'} in ${esc(title)}.</p>
        <div class="row" style="justify-content:center">
          <button class="btn-sec" id="restartBtn">↺ Study again</button>
          <button class="btn-primary" style="width:auto" id="doneBtn">Done</button>
        </div>
      </div>
    `);
    document.getElementById('restartBtn')?.addEventListener('click', () => {
      flushAllAnswerSaves();
      pos = 0;
      flipped = false;
      render();
    });
    document.getElementById('doneBtn')?.addEventListener('click', deps.onBack);
  }

  await load();
}
