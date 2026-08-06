import './style.css';
import type { Session } from '@supabase/supabase-js';
import { getMyRole, getSession, onAuthChange, signOut } from './lib/auth';
import { loadQueueAcrossAllDecks, loadQueueForDeck } from './lib/cards';
import { ensureDefaultDecksCloned, listDecksWithCounts } from './lib/decks';
import { renderAuth } from './pages/auth';
import { renderResetPassword } from './pages/resetPassword';
import { renderSettings } from './pages/settings';
import { renderLibrary } from './pages/library';
import { renderDeckDetail } from './pages/deck';
import { renderSession } from './pages/session';
import { renderPageReview } from './pages/pageReview';
import { renderImportContent } from './pages/import';
import { renderImportDetail } from './pages/importDetail';
import { renderStacksList } from './pages/stacksList';
import { renderDeckSync } from './pages/deckSync';
import { renderStudyPicker } from './pages/studyPicker';
import { renderStudyMode } from './pages/studyMode';
import { initAccentKeyboard } from './lib/accentKeyboard';
import { initTheme } from './lib/theme';
import { $, errMsg, esc, pinToast, toast } from './lib/dom';
import type { CardWithNote, Deck, DeckWithCounts } from './types';

const app = $(document, '#app');
const topRight = $(document, '#topRight');

initAccentKeyboard();
initTheme($<HTMLInputElement>(document, '#themeToggle'));

type View =
  | { name: 'library' }
  | { name: 'deck'; deckId: string }
  /** `decks` carries every deck a card in `queue` might belong to — one entry for a normal per-deck session, several for global "practice everything due". */
  | { name: 'session'; decks: Map<string, Deck>; queue: CardWithNote[] }
  | { name: 'page-review'; deckId: string; deckName: string; importId: string | null; initialPageId?: string }
  | { name: 'import'; deckId: string; deckName: string }
  /** The durable, permanent home for one import — always a real import_id, never "the latest". */
  | { name: 'import-detail'; deckId: string; deckName: string; importId: string }
  /** Manage-content: browse/edit this deck's stacks. Nothing about studying lives here — see 'study-picker'. */
  | { name: 'stacks-list'; deckId: string; deckName: string }
  /** "Sync with original deck" — its own page (explanation + action + history), not a button buried in an overflow menu. Only reachable for a deck that's actually a clone. */
  | { name: 'deck-sync'; deckId: string }
  /** Study's own front door — pick which stack(s), optionally narrowed by tag, before handing off to 'study-mode'. */
  | { name: 'study-picker'; deckId: string; deckName: string }
  /** Study mode: no scheduling, just a sequential walk through whichever stack(s) were selected on the Study picker — optionally narrowed by tag. `tileCount` is how many tiles were picked (see StudyPickerDeps.onStudySelected) — what the header should call "N stacks", not stackIds.length. */
  | { name: 'study-mode'; deckId: string; deckName: string; stackIds: string[]; tagFilter: string[]; tileCount: number }
  | { name: 'settings' };
let view: View = { name: 'library' };
let wasAuthenticated = false;
/** Set when the app was reached via a password-reset email link (see index.html's `type=recovery` detection) — overrides normal routing until a new password is saved. */
let pendingPasswordRecovery = false;
let disposeSession: (() => void) | null = null;
let disposeImportDetail: (() => void) | null = null;
/** Purely a UI-visibility flag now (admin-only monitoring panel) — doesn't gate import capability, see 20260812000000_retire_admin_role.sql. */
let isAdmin = false;
/** Fires once per app load, from library's onStatsLoaded rather than route() itself — the streak badge arriving later grows #topRight, and since .top-right-group is right-aligned (margin-left:auto), that shifts the theme toggle left. Pinning the hint before that settles strands it at the toggle's pre-shift position. */
let themeHintShown = false;

function renderHeader(session: Session | null, streak?: number): void {
  if (!session) {
    topRight.innerHTML = '';
    return;
  }
  topRight.innerHTML = `
    ${streak != null ? `<div class="gstat flame" title="Study streak">🔥 <span class="v">${streak}</span></div>` : ''}
    <div class="avatar-menu">
      <button class="avatar" id="avatarBtn" title="${esc(session.user.email)}">${esc((session.user.email ?? '?')[0].toUpperCase())}</button>
      <div class="avatar-dropdown" id="avatarDropdown">
        <div class="avatar-dropdown-email">${esc(session.user.email)}</div>
        <button class="avatar-dropdown-item" id="settingsBtn">Settings</button>
        <button class="avatar-dropdown-item danger" id="signOutBtn">Sign out</button>
      </div>
    </div>
  `;
  $(topRight, '#avatarBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $(topRight, '#avatarDropdown').classList.toggle('open');
  });
  $(topRight, '#settingsBtn').addEventListener('click', () => {
    $(topRight, '#avatarDropdown').classList.remove('open');
    view = { name: 'settings' };
    renderView(session);
  });
  $(topRight, '#signOutBtn').addEventListener('click', () => void signOut());
}

// Attached once, not per renderHeader() call (renderHeader re-renders topRight's
// innerHTML — e.g. whenever due/streak stats load — which would otherwise stack
// up a fresh document-level listener, each still closing over the now-detached
// old dropdown element, on every re-render).
document.addEventListener('click', (e) => {
  const dropdown = topRight.querySelector('#avatarDropdown');
  if (!dropdown || !dropdown.classList.contains('open')) return;
  if (e.target instanceof Node && !dropdown.contains(e.target) && e.target !== topRight.querySelector('#avatarBtn')) {
    dropdown.classList.remove('open');
  }
});

async function startSession(session: Session, deck: DeckWithCounts): Promise<void> {
  try {
    const queue = await loadQueueForDeck(deck);
    if (!queue.length) {
      toast('Nothing due right now');
      return;
    }
    view = { name: 'session', decks: new Map([[deck.id, deck]]), queue };
    renderView(session);
  } catch (e) {
    toast('Could not start session: ' + errMsg(e));
  }
}

/** Global practice: every deck's due+new pool combined into one session — the zero-configuration, cross-deck counterpart to startSession. */
async function startGlobalSession(session: Session): Promise<void> {
  try {
    const decks = await listDecksWithCounts();
    const queue = await loadQueueAcrossAllDecks(decks);
    if (!queue.length) {
      toast('Nothing due right now');
      return;
    }
    view = { name: 'session', decks: new Map(decks.map((d) => [d.id, d])), queue };
    renderView(session);
  } catch (e) {
    toast('Could not start practice: ' + errMsg(e));
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
      onStudyAll: () => void startGlobalSession(session),
      onStatsLoaded: (_totalDue, streakCurrent) => {
        renderHeader(session, streakCurrent);
        if (!themeHintShown) {
          themeHintShown = true;
          const themeSwitch = document.querySelector<HTMLElement>('.theme-switch');
          if (themeSwitch) pinToast(themeSwitch, 'Try the dark / light mode', 3000);
        }
      },
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
      onStartSession: (deck) => void startSession(session, deck),
      onOpenStudyPicker: (id, name) => {
        view = { name: 'study-picker', deckId: id, deckName: name };
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
      onOpenStacks: (id, name) => {
        view = { name: 'stacks-list', deckId: id, deckName: name };
        renderView(session);
      },
      onOpenDeckSync: (id) => {
        view = { name: 'deck-sync', deckId: id };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'stacks-list') {
    const { deckId, deckName } = view;
    void renderStacksList(app, {
      deckId,
      deckName,
      onBack: () => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
      onOpenPageStack: (importId, pageId) => {
        view = { name: 'page-review', deckId, deckName, importId, initialPageId: pageId };
        renderView(session);
      },
      onOpenImportDetail: (id, name, importId) => {
        view = { name: 'import-detail', deckId: id, deckName: name, importId };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'deck-sync') {
    const { deckId } = view;
    void renderDeckSync(app, deckId, {
      onBack: () => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'study-picker') {
    const { deckId, deckName } = view;
    void renderStudyPicker(app, {
      deckId,
      deckName,
      onBack: () => {
        view = { name: 'deck', deckId };
        renderView(session);
      },
      onStudySelected: (stackIds, tagFilter, tileCount) => {
        view = { name: 'study-mode', deckId, deckName, stackIds, tagFilter, tileCount };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'study-mode') {
    const { deckId, deckName, stackIds, tagFilter, tileCount } = view;
    void renderStudyMode(app, {
      stackIds,
      tagFilter,
      tileCount,
      onBack: () => {
        view = { name: 'study-picker', deckId, deckName };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'session') {
    const { decks } = view;
    // A single-deck session returns to that deck; a global (multi-deck) one has no single deck to go back to, so it returns to the library instead.
    const singleDeckId = decks.size === 1 ? [...decks.keys()][0] : null;
    disposeSession = renderSession(app, decks, view.queue, {
      onEnd: () => {
        view = singleDeckId ? { name: 'deck', deckId: singleDeckId } : { name: 'library' };
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
    const { deckId, deckName, importId, initialPageId } = view;
    void renderPageReview(app, {
      deckId,
      deckName,
      importId,
      initialPageId,
      onBack: () => {
        view = { name: 'stacks-list', deckId, deckName };
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
        view = { name: 'stacks-list', deckId, deckName };
        renderView(session);
      },
      onOpenPageReview: (id) => {
        view = { name: 'page-review', deckId, deckName, importId: id };
        renderView(session);
      },
    });
    return;
  }
  if (view.name === 'settings') {
    renderSettings(app, {
      currentUserEmail: session.user.email ?? '',
      onBack: () => {
        view = { name: 'library' };
        renderView(session);
      },
      onAccountDeleted: () => void signOut(),
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
  if (sessionStorage.getItem('ff-recovery-callback')) {
    sessionStorage.removeItem('ff-recovery-callback');
    history.replaceState(null, '', window.location.pathname); // drop the #access_token=... fragment from the address bar
    pendingPasswordRecovery = true;
  }
  if (pendingPasswordRecovery) {
    disposeSession?.();
    disposeSession = null;
    renderResetPassword(app, {
      onDone: () => {
        pendingPasswordRecovery = false;
        wasAuthenticated = true;
        toast('Password updated — you’re all set!');
        view = { name: 'library' };
        renderView(session);
      },
    });
    return;
  }
  if (wasAuthenticated) return; // token refresh etc. — keep whatever page is already showing
  wasAuthenticated = true;
  if (sessionStorage.getItem('ff-auth-callback')) {
    sessionStorage.removeItem('ff-auth-callback');
    history.replaceState(null, '', window.location.pathname); // drop the #access_token=... fragment from the address bar
    toast('Email confirmed — you’re all set!');
  }
  isAdmin = false;
  getMyRole()
    .then((role) => {
      isAdmin = role === 'admin';
      if (view.name === 'import-detail') renderView(session);
    })
    .catch(() => {
      /* not fatal — the admin-only monitoring panel just stays hidden */
    });
  // Best-effort, once per real sign-in (not token refreshes, thanks to the
  // wasAuthenticated guard above) — re-render the library afterward so a
  // freshly-cloned default deck shows up without the learner needing to
  // manually refresh. Errors are already swallowed inside the function
  // itself; nothing here should ever block getting to renderView below.
  ensureDefaultDecksCloned()
    .then(() => {
      if (view.name === 'library') renderView(session);
    })
    .catch(() => {
      /* already logged inside ensureDefaultDecksCloned; nothing more to do here */
    });
  renderView(session);
}

onAuthChange((session) => route(session));

getSession().then(route);
