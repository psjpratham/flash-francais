import { supabase } from './supabase';
import type { Deck, DeckStatsWithStreak, DeckTagCount, DeckWithCounts, PublicDeckSearchResult } from '../types';

/** The short, human-friendly form of a deck id shown in the UI (deck header, search results) — the id's first 8 hex characters, upper-cased. Search-by-id also matches on this prefix (see search_public_decks). */
export function shortDeckId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

/**
 * The decks that belong in "Your decks": only ones the current user actually
 * owns. Explicitly scoped rather than relying on RLS alone — RLS's
 * decks_select also allows any *other* user's `is_public` deck through
 * (that's what makes search_public_decks work), so an unfiltered select here
 * would leak every public deck into every user's library the moment it's
 * marked public. Public decks are only ever meant to surface via search,
 * never auto-added to anyone's collection.
 *
 * Admin-curated `visibility='shared'` default decks used to be unioned in
 * here directly (live-referencing the original rows), which let anyone open
 * Practice on a deck they didn't actually own — cards_update has no RLS
 * branch granting write access there (by design, see
 * 20260814000000_shared_deck_read_access.sql), so every grade silently
 * failed to save and the same cards never left the queue. Fixed by giving
 * every user a REAL, fully-owned clone instead (see ensureDefaultDecksCloned)
 * — once that's guaranteed, this can go back to only ever meaning "decks I
 * own."
 */
export async function listDecks(): Promise<Deck[]> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Not signed in');

  const { data, error } = await supabase
    .from('decks')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

/** Every admin-curated default deck currently offered to new/existing users — the catalog ensureDefaultDecksCloned clones from. Readable by anyone via decks_select's `visibility='shared' AND status='published'` branch. */
async function listSharedDefaultDecks(): Promise<Deck[]> {
  const { data, error } = await supabase.from('decks').select('*').eq('visibility', 'shared').eq('status', 'published');
  if (error) throw error;
  return data;
}

/**
 * Ensures the signed-in user has their own clone of every current
 * admin-curated default deck — called once per login (see main.ts), and
 * safe/cheap to call repeatedly (a no-op once every default is cloned). Each
 * missing clone is best-effort: one failing (e.g. a transient network blip)
 * shouldn't block the others or the rest of app startup, so failures are
 * swallowed here rather than surfaced — the next login retries whatever
 * didn't finish.
 */
export async function ensureDefaultDecksCloned(): Promise<void> {
  const [defaults, mine] = await Promise.all([listSharedDefaultDecks(), listDecks()]);
  if (!defaults.length) return;
  const alreadyCloned = new Set(mine.map((d) => d.cloned_from_deck_id).filter((id): id is string => !!id));
  const missing = defaults.filter((d) => !alreadyCloned.has(d.id));
  await Promise.all(
    missing.map((d) =>
      addPublicDeckToMyDecks(d.id, d.name).catch((e) => {
        console.error('ensureDefaultDecksCloned: failed to clone default deck', d.id, e);
      }),
    ),
  );
}

/** Attaches `_due`/`_new` card counts to each deck (one pair of count queries per deck, run concurrently). */
export async function withDeckCounts(decks: Deck[]): Promise<DeckWithCounts[]> {
  const nowISO = new Date().toISOString();
  return Promise.all(
    decks.map(async (d): Promise<DeckWithCounts> => {
      const [dueRes, newRes] = await Promise.all([
        supabase
          .from('cards')
          .select('id', { count: 'exact', head: true })
          .eq('deck_id', d.id)
          .eq('include_in_practice', true)
          .neq('state', 'new')
          .lte('due', nowISO),
        supabase
          .from('cards')
          .select('id', { count: 'exact', head: true })
          .eq('deck_id', d.id)
          .eq('include_in_practice', true)
          .eq('state', 'new'),
      ]);
      if (dueRes.error) throw dueRes.error;
      if (newRes.error) throw newRes.error;
      return { ...d, _due: dueRes.count ?? 0, _new: newRes.count ?? 0 };
    }),
  );
}

/** Convenience: `listDecks` + `withDeckCounts` in one call, matching the old prototype's `loadDecks`. */
export async function listDecksWithCounts(): Promise<DeckWithCounts[]> {
  return withDeckCounts(await listDecks());
}

export async function getDeck(id: string): Promise<Deck> {
  const { data, error } = await supabase.from('decks').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function getDeckWithCounts(id: string): Promise<DeckWithCounts> {
  const [withCounts] = await withDeckCounts([await getDeck(id)]);
  return withCounts;
}

export async function createDeck(name: string): Promise<Deck> {
  const { data, error } = await supabase.from('decks').insert({ name }).select().single();
  if (error) throw error;
  return data;
}

/** Creates a shared draft deck. RLS requires the caller to be an admin. */
export async function createSharedDraftDeck(name: string): Promise<Deck> {
  const { data, error } = await supabase
    .from('decks')
    .insert({ name, visibility: 'shared', status: 'draft' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function renameDeck(deckId: string, name: string): Promise<Deck> {
  const { data, error } = await supabase.from('decks').update({ name }).eq('id', deckId).select().single();
  if (error) throw error;
  return data;
}

/**
 * Publishes an admin-owned shared draft deck, making it readable by all
 * authenticated users. RLS enforces that only the deck's admin owner can do
 * this (decks_update); anyone else's attempt matches zero rows.
 */
export async function publishDeck(deckId: string): Promise<Deck> {
  const { data, error } = await supabase
    .from('decks')
    .update({ status: 'published' })
    .eq('id', deckId)
    .eq('visibility', 'shared')
    .eq('status', 'draft')
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Toggles whether this deck is publicly searchable/readable by every other
 * authenticated user (see search_public_decks). RLS (`decks_update`)
 * restricts this to the deck's owner. Independent of the admin-curated
 * `visibility='shared'` system.
 */
export async function setDeckPublic(deckId: string, isPublic: boolean): Promise<Deck> {
  const { data, error } = await supabase.from('decks').update({ is_public: isPublic }).eq('id', deckId).select().single();
  if (error) throw error;
  return data;
}

/** Searches every other user's public deck by title, author display name, or id prefix (see shortDeckId) — empty/blank query returns the most recently published public decks. */
export async function searchPublicDecks(query: string): Promise<PublicDeckSearchResult[]> {
  const { data, error } = await supabase.rpc('search_public_decks', { p_query: query.trim() || null });
  if (error) throw error;
  return data;
}

interface CloneDeckResponse {
  ok: boolean;
  deck?: Deck;
  cardCount?: number;
  error?: string;
}

/**
 * Adds a public deck to the caller's own library — a complete, independent,
 * physical copy: every card regardless of origin, every referenced source
 * page, and every referenced image/PDF/audio file, all duplicated into rows
 * and storage paths the caller owns, with fresh FSRS state (new cards,
 * never studied). Never a link to the original — studying it can't affect
 * the original owner's progress, and the original being edited, un-
 * published, or deleted later can't affect this copy either.
 *
 * Goes through an edge function (see supabase/functions/clone-public-deck),
 * not a plain RPC, because copying the actual file bytes in Storage isn't
 * something a SQL function can do — only the Storage API can, which means
 * running with the service-role key.
 */
export async function addPublicDeckToMyDecks(sourceDeckId: string, name?: string): Promise<Deck> {
  const { data, error } = await supabase.functions.invoke<CloneDeckResponse>('clone-public-deck', {
    body: { sourceDeckId, name: name ?? null },
  });
  if (error) throw new Error(await cloneErrorMessage(error));
  if (!data?.ok || !data.deck) throw new Error(data?.error ?? 'Could not add this deck.');
  return data.deck;
}

/**
 * supabase.functions.invoke's error on a non-2xx response is always the
 * generic "Edge Function returned a non-2xx status code" (see
 * FunctionsHttpError in @supabase/functions-js) — the function's own
 * `{ ok: false, error: "..." }` JSON body, which has the actual reason, is
 * left on `error.context` (the raw Response) and never surfaced
 * automatically. Read it so a failed clone shows the real cause, not just
 * "non-2xx code".
 */
async function cloneErrorMessage(error: { message: string; context?: unknown }): Promise<string> {
  const context = error.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as Partial<CloneDeckResponse>;
      if (body?.error) return body.error;
    } catch {
      /* body wasn't JSON (e.g. a platform-level 546/504) — fall through to the generic message */
    }
  }
  return error.message;
}

/**
 * Combined stats + streak for a deck, or for all decks when `deckId` is null.
 * Two RPC round-trips total; all aggregation happens in Postgres (see
 * supabase_stats_functions.sql: get_stats / get_streak).
 */
export async function fetchDeckStats(deckId: string | null): Promise<DeckStatsWithStreak> {
  const [statsRes, streakRes] = await Promise.all([
    supabase.rpc('get_stats', { p_deck_id: deckId }),
    supabase.rpc('get_streak', {}),
  ]);
  if (statsRes.error) throw statsRes.error;
  if (streakRes.error) throw streakRes.error;
  return { ...statsRes.data, streak: streakRes.data };
}

export async function fetchDeckTags(deckId: string): Promise<DeckTagCount[]> {
  const { data, error } = await supabase.rpc('get_deck_tags', { p_deck_id: deckId });
  if (error) throw error;
  return data;
}

/**
 * Permanently deletes a deck and everything under it: cards (both manual and
 * textbook-derived, unified — see migration 20260728000000), review logs,
 * stacks, imports, import_files, import_pages, import_audio_files, jobs, and
 * the uploaded files/renders in the three private storage buckets
 * (import-sources, import-audio, import-page-renders).
 *
 * Every dependent table's deck_id (or transitive) foreign key is already
 * ON DELETE CASCADE (verified against the live schema — see the deck
 * deletion feature notes), so a single `delete from decks` clears every DB
 * row. Storage objects are not part of that FK graph, so they're removed
 * first — while the `imports` rows (and the storage RLS policies that key off
 * them) still exist — and only then is the deck row deleted. If storage
 * cleanup fails, the deck is left fully intact rather than partially
 * deleted, so the admin can retry safely.
 *
 * RLS (`decks_delete`) already restricts this to the deck's owner — a
 * non-owner's delete matches zero rows rather than throwing, which is
 * treated here as a failure rather than a silent no-op success.
 */
export async function deleteDeckDeep(deckId: string): Promise<void> {
  const { data: imports, error: importsError } = await supabase.from('imports').select('id').eq('deck_id', deckId);
  if (importsError) throw importsError;

  if (imports.length) {
    const importIds = imports.map((i) => i.id);

    const { data: files, error: filesError } = await supabase.from('import_files').select('storage_path').in('import_id', importIds);
    if (filesError) throw filesError;
    if (files.length) {
      const { error: removeError } = await supabase.storage.from('import-sources').remove(files.map((f) => f.storage_path));
      if (removeError) throw removeError;
    }

    const { data: audioFiles, error: audioError } = await supabase.from('import_audio_files').select('storage_path').in('import_id', importIds);
    if (audioError) throw audioError;
    if (audioFiles.length) {
      const { error: removeAudioError } = await supabase.storage.from('import-audio').remove(audioFiles.map((f) => f.storage_path));
      if (removeAudioError) throw removeAudioError;
    }

    const { data: pages, error: pagesError } = await supabase
      .from('import_pages')
      .select('rendered_page_path')
      .in('import_id', importIds)
      .not('rendered_page_path', 'is', null);
    if (pagesError) throw pagesError;
    if (pages.length) {
      const { error: removeRendersError } = await supabase.storage.from('import-page-renders').remove(pages.map((p) => p.rendered_page_path as string));
      if (removeRendersError) throw removeRendersError;
    }
  }

  const { data: deleted, error: deleteError } = await supabase.from('decks').delete().eq('id', deckId).select('id');
  if (deleteError) throw deleteError;
  if (!deleted || deleted.length === 0) {
    throw new Error('Deck not found, or you do not have permission to delete it.');
  }
}
