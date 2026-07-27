import { supabase } from './supabase';
import type { Deck, DeckStatsWithStreak, DeckTagCount, DeckWithCounts } from '../types';

/** All of the current user's decks, ordered oldest-first (RLS scopes this to their own rows). */
export async function listDecks(): Promise<Deck[]> {
  const { data, error } = await supabase.from('decks').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data;
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
          .neq('state', 'new')
          .lte('due', nowISO),
        supabase.from('cards').select('id', { count: 'exact', head: true }).eq('deck_id', d.id).eq('state', 'new'),
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
 * Permanently deletes a deck and everything under it: cards, notes, review
 * logs, imports, import_files, import_pages, page_extractions, page_blocks,
 * import_audio_files, jobs, and the uploaded files/renders in the three
 * private storage buckets (import-sources, import-audio, import-page-renders).
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
