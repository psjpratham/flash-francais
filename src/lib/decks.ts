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
