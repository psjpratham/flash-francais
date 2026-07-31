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
import { applyAnswerState, pronIconHTML, renderFlashcardDetailHTML, renderReadModeBlock, wireAnswerCapture, wirePronunciationIcons, wireReadModeBlock } from '../lib/readModeRenderers';
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
}

export async function renderStudyMode(container: HTMLElement, deps: StudyModeDeps): Promise<void> {
  let cards: CardWithNote[] = [];
  let title = '';
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
      title = stackInfos.length === 1 ? stackInfos[0].name : `${stackInfos.length} stacks`;
      cards = stackCards;

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
        <button class="back-link" id="backBtn">← ${esc(title || 'Back')}</button>
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
      <div id="studyCardArea">${cardHTML(card)}</div>
      <div class="row" style="justify-content:center;margin-top:16px" id="studyControls"></div>
    `);
    wireCard(card);
    renderControls();
  }

  /** Page-stack cards render read-only (nothing to guess, so nothing to flip) in the same split page-image view the review UI and practice session both use — studying one reads exactly like reviewing it. The source pane only shows when this card's own "show source in study mode" toggle is on — independent of its Practice-mode counterpart. */
  function importedFace(card: CardWithNote): string {
    const content = `<div class="session-imported-left" data-read-block-id="${esc(card.id)}">${renderReadModeBlock(card, new Map(), true)}</div>`;
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
      }
      return;
    }
    document.getElementById('studyFlipCard')?.addEventListener('click', () => {
      flipped = !flipped;
      render();
    });
  }

  function renderControls(): void {
    const el = document.getElementById('studyControls');
    if (!el) return;
    el.innerHTML = `
      <button class="btn-sec" id="prevBtn" ${pos === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="btn-primary" style="width:auto" id="nextBtn">${pos === cards.length - 1 ? 'Finish' : 'Next →'}</button>`;
    $(el, '#prevBtn').addEventListener('click', () => {
      flushAllAnswerSaves();
      pos = Math.max(0, pos - 1);
      flipped = false;
      render();
    });
    $(el, '#nextBtn').addEventListener('click', () => {
      flushAllAnswerSaves();
      pos += 1;
      flipped = false;
      render();
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
