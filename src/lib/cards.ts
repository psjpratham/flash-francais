import { supabase } from './supabase';
import { scheduleCard } from './fsrs';
import type { Card, CardWithNote, Deck, Note, NoteFields, NoteType, Rating } from '../types';

// The page_blocks/import_pages embed is only ever non-null for a note
// compiled from an import (source_block_id set) — see sendPageBlocksToPractice
// in pageExtractions.ts. Live-referenced, not snapshotted: relies on the
// querying user passing page_blocks' own RLS (admin + import owner), which
// holds today because the same person creates and studies their imports.
const NOTES_SELECT = 'fields,note_type,tags,source_block_id,page_blocks(*,import_pages(rendered_page_path))';

/** One card to import: optional note_type/tags, plus the note's fields (front/back/etc). */
export type ImportItem = Partial<Pick<Note, 'note_type' | 'tags'>> & NoteFields;

/** Inserts notes + their initial `new` cards in batches of 80, matching the old prototype. */
export async function bulkInsertNotesAndCards(
  deckId: string,
  defaultNoteType: NoteType,
  items: ImportItem[],
): Promise<void> {
  const BATCH = 80;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const { data: noteRows, error: notesError } = await supabase
      .from('notes')
      .insert(
        batch.map(({ note_type, tags, ...fields }) => ({
          deck_id: deckId,
          note_type: note_type ?? defaultNoteType,
          tags: tags ?? [],
          fields,
        })),
      )
      .select();
    if (notesError) throw notesError;

    const cardRows = noteRows.map((n) => ({
      note_id: n.id,
      deck_id: deckId,
      state: 'new' as const,
      due: new Date().toISOString(),
    }));
    const { error: cardsError } = await supabase.from('cards').insert(cardRows);
    if (cardsError) throw cardsError;
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Builds a study queue for a deck: due cards + new cards (up to the deck's daily limits), lightly shuffled. */
export async function loadQueueForDeck(deck: Deck, tags?: string[]): Promise<CardWithNote[]> {
  const nowISO = new Date().toISOString();
  const filterByTags = !!tags?.length;
  const notesRelation = filterByTags ? `notes!inner(${NOTES_SELECT})` : `notes(${NOTES_SELECT})`;

  let dueQuery = supabase
    .from('cards')
    .select(`*,${notesRelation}`)
    .eq('deck_id', deck.id)
    .neq('state', 'new')
    .lte('due', nowISO)
    .order('due', { ascending: true })
    .limit(deck.review_per_day);
  let newQuery = supabase
    .from('cards')
    .select(`*,${notesRelation}`)
    .eq('deck_id', deck.id)
    .eq('state', 'new')
    .order('created_at', { ascending: true })
    .limit(deck.new_per_day);
  if (filterByTags) {
    dueQuery = dueQuery.overlaps('notes.tags', tags!);
    newQuery = newQuery.overlaps('notes.tags', tags!);
  }

  const [dueRes, newRes] = await Promise.all([dueQuery, newQuery]);
  if (dueRes.error) throw dueRes.error;
  if (newRes.error) throw newRes.error;

  return shuffle([...dueRes.data, ...newRes.data]);
}

/** Schedules the card via FSRS, persists the new card state, and logs the review. */
export async function commitGrade(card: Card, grade: Rating, retention: number): Promise<void> {
  const now = Date.now();
  const patch = scheduleCard(card, grade, retention, now);

  const { error: cardError } = await supabase.from('cards').update(patch).eq('id', card.id);
  if (cardError) throw cardError;

  const elapsedDays = card.last_review ? (now - new Date(card.last_review).getTime()) / 86400000 : 0;
  const { error: logError } = await supabase.from('review_log').insert({
    card_id: card.id,
    rating: grade,
    state_before: card.state,
    stability: patch.stability!,
    difficulty: patch.difficulty!,
    elapsed_days: elapsedDays,
  });
  if (logError) throw logError;
}
