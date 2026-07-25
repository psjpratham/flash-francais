import './style.css';
import type { Session } from '@supabase/supabase-js';
import { getSession, onAuthChange, signOut } from './lib/auth';
import { loadQueueForDeck } from './lib/cards';
import { renderAuth } from './pages/auth';
import { renderLibrary } from './pages/library';
import { renderDeckDetail } from './pages/deck';
import { renderSession } from './pages/session';
import { renderBookList, renderBookReader } from './pages/book';
import { $, errMsg, esc, toast } from './lib/dom';
import type { BookLesson, CardWithNote, DeckWithCounts } from './types';

const app = $(document, '#app');
const topRight = $(document, '#topRight');

type View =
  | { name: 'library' }
  | { name: 'deck'; deckId: string }
  | { name: 'session'; deck: DeckWithCounts; queue: CardWithNote[] }
  | { name: 'book-list'; deckId: string }
  | { name: 'book-reader'; deckId: string; lesson: BookLesson };
let view: View = { name: 'library' };
let wasAuthenticated = false;
let disposeSession: (() => void) | null = null;

function renderHeader(session: Session | null, due?: number, streak?: number): void {
  if (!session) {
    topRight.innerHTML = '';
    return;
  }
  topRight.innerHTML = `
    ${streak != null ? `<div class="gstat flame" title="Study streak">🔥 <span class="v">${streak}</span></div>` : ''}
    ${due != null ? `<div class="gstat due" title="Cards due">Due <span class="v">${due}</span></div>` : ''}
    <span class="signout" id="signOutBtn">Sign out</span>
    <div class="avatar" title="${esc(session.user.email)}">${esc((session.user.email ?? '?')[0].toUpperCase())}</div>
  `;
  $(topRight, '#signOutBtn').addEventListener('click', () => void signOut());
}

async function startSession(session: Session, deck: DeckWithCounts, tagFilter: string[]): Promise<void> {
  try {
    const queue = await loadQueueForDeck(deck, tagFilter);
    if (!queue.length) {
      toast(tagFilter.length ? 'No cards match that tag filter' : 'Nothing due right now');
      return;
    }
    view = { name: 'session', deck, queue };
    renderView(session);
  } catch (e) {
    toast('Could not start session: ' + errMsg(e));
  }
}

function renderView(session: Session): void {
  disposeSession?.();
  disposeSession = null;
  if (view.name === 'library') {
    void renderLibrary(app, {
      onOpenDeck: (deckId) => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
      onStudyAll: () => toast('Study session — coming soon'),
      onStatsLoaded: (totalDue, streakCurrent) => renderHeader(session, totalDue, streakCurrent),
    });
    return;
  }
  if (view.name === 'deck') {
    const deckId = view.deckId;
    void renderDeckDetail(app, deckId, {
      onBack: () => {
        view = { name: 'library' };
        renderView(session);
      },
      onStartSession: (deck, tagFilter) => void startSession(session, deck, tagFilter),
      onReadBook: () => {
        view = { name: 'book-list', deckId };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'session') {
    const deckId = view.deck.id;
    disposeSession = renderSession(app, view.deck, view.queue, {
      onEnd: () => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
      onSeeAllStats: () => {
        view = { name: 'library' };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'book-list') {
    const deckId = view.deckId;
    void renderBookList(app, {
      onOpenLesson: (lesson) => {
        view = { name: 'book-reader', deckId, lesson };
        renderView(session);
      },
      onBack: () => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
    });
    return;
  }
  const bookDeckId = view.deckId;
  renderBookReader(app, view.lesson, {
    onBack: () => {
      view = { name: 'book-list', deckId: bookDeckId };
      renderView(session);
    },
  });
}

function route(session: Session | null): void {
  renderHeader(session);
  if (!session) {
    wasAuthenticated = false;
    view = { name: 'library' };
    disposeSession?.();
    disposeSession = null;
    renderAuth(app, () => {
      /* onAuthChange below picks up the new session and re-routes */
    });
    return;
  }
  if (wasAuthenticated) return; // token refresh etc. — keep whatever page is already showing
  wasAuthenticated = true;
  renderView(session);
}

onAuthChange((session) => route(session));

getSession().then(route);
