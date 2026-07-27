import './style.css';
import type { Session } from '@supabase/supabase-js';
import { getMyRole, getSession, onAuthChange, signOut } from './lib/auth';
import { loadQueueForDeck } from './lib/cards';
import { renderAuth } from './pages/auth';
import { renderLibrary } from './pages/library';
import { renderDeckDetail } from './pages/deck';
import { renderSession } from './pages/session';
import { renderPageReview } from './pages/pageReview';
import { renderImportContent } from './pages/import';
import { renderImportDetail } from './pages/importDetail';
import { initAccentKeyboard } from './lib/accentKeyboard';
import { $, errMsg, esc, toast } from './lib/dom';
import type { CardWithNote, DeckWithCounts } from './types';

const app = $(document, '#app');
const topRight = $(document, '#topRight');

initAccentKeyboard();

type View =
  | { name: 'library' }
  | { name: 'deck'; deckId: string }
  | { name: 'session'; deck: DeckWithCounts; queue: CardWithNote[] }
  | { name: 'page-review'; deckId: string; deckName: string; importId: string | null }
  | { name: 'import'; deckId: string; deckName: string }
  /** The durable, permanent home for one import — always a real import_id, never "the latest". */
  | { name: 'import-detail'; deckId: string; deckName: string; importId: string };
let view: View = { name: 'library' };
let wasAuthenticated = false;
let disposeSession: (() => void) | null = null;
let disposeImportDetail: (() => void) | null = null;
let isAdmin = false;

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
  disposeImportDetail?.();
  disposeImportDetail = null;
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
      onOpenImport: (id, name, importId) => {
        view = { name: 'import-detail', deckId: id, deckName: name, importId };
        renderView(session);
      },
      currentUserId: session.user.id,
      onDeleted: () => {
        view = { name: 'library' };
        renderView(session);
      },
      onImportContent: (id, name) => {
        view = { name: 'import', deckId: id, deckName: name };
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
  if (view.name === 'page-review') {
    const { deckId, deckName, importId } = view;
    void renderPageReview(app, {
      deckId,
      deckName,
      importId,
      onBack: () => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'import-detail') {
    const { deckId, deckName, importId } = view;
    disposeImportDetail = renderImportDetail(app, {
      deckId,
      deckName,
      importId,
      isAdmin,
      onBack: () => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
      onOpenPageReview: (id) => {
        view = { name: 'page-review', deckId, deckName, importId: id };
        renderView(session);
      },
    });
    return;
  }
  const importDeckId = view.deckId;
  const importDeckName = view.deckName;
  renderImportContent(app, {
    onBack: () => {
      view = { name: 'deck', deckId: importDeckId };
      renderView(session);
    },
    // Persist-and-hand-off: the moment an import exists server-side, jump
    // straight to its durable route — there is no "in-progress upload"
    // state left in this view for a reload to lose.
    onImportCreated: (importId) => {
      view = { name: 'import-detail', deckId: importDeckId, deckName: importDeckName, importId };
      renderView(session);
    },
    deckId: view.deckId,
    deckName: view.deckName,
    isAdmin,
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
  isAdmin = false;
  getMyRole()
    .then((role) => {
      isAdmin = role === 'admin';
      if (view.name === 'library') renderView(session);
    })
    .catch(() => {
      /* not fatal — the import entry point just stays hidden */
    });
  renderView(session);
}

onAuthChange((session) => route(session));

getSession().then(route);
