import { supabase } from './supabase';
import { scheduleCard } from './fsrs';
import type { Card, CardWithNote, Deck, NoteFields, NoteType, Rating } from '../types';

/** One card to import: optional note_type/tags, plus the note's fields (front/back/etc). */
export type ImportItem = { note_type?: NoteType; tags?: string[] } & NoteFields;

const MANUAL_STACK_NAME = 'Manual cards';

/**
 * Every deck's manually/paste/JSON-authored cards live in one synthetic
 * 'custom' stack — created lazily on first use. Looked up by name, not just
 * kind='custom': a deck can now also have an image-source import's shared
 * stack (see createImport in imports.ts), which is ALSO kind='custom' —
 * matching on kind alone would grab whichever custom stack happens to exist
 * first and silently file manual cards into the wrong one.
 */
async function getOrCreateManualStack(deckId: string): Promise<string> {
  const { data: existing, error } = await supabase
    .from('stacks')
    .select('id')
    .eq('deck_id', deckId)
    .eq('kind', 'custom')
    .eq('name', MANUAL_STACK_NAME)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing.id;

  const { data: created, error: createError } = await supabase.from('stacks').insert({ deck_id: deckId, name: MANUAL_STACK_NAME, kind: 'custom', version: 1 }).select('id').single();
  if (createError) throw createError;
  return created.id;
}

/** Inserts cards (origin='manual') in batches of 80, matching the old prototype's note+card insert. */
export async function bulkInsertNotesAndCards(
  deckId: string,
  defaultNoteType: NoteType,
  items: ImportItem[],
): Promise<void> {
  const stackId = await getOrCreateManualStack(deckId);
  const BATCH = 80;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const { error } = await supabase.from('cards').insert(
      batch.map(({ note_type, tags, ...fields }, idx) => ({
        stack_id: stackId,
        deck_id: deckId,
        order_index: i + idx,
        origin: 'manual' as const,
        note_type: note_type ?? defaultNoteType,
        tags: tags ?? [],
        fields,
        state: 'new' as const,
        due: new Date().toISOString(),
      })),
    );
    if (error) throw error;
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Builds a practice queue for a deck: due cards + new cards (up to the
 * deck's daily limits), lightly shuffled. Only cards explicitly marked
 * include_in_practice ever enter the queue — a never-sent imported card
 * must stay invisible here.
 *
 * Deliberately no filtering of any kind (no tags, no stack scoping) — the
 * whole point of Practice is that the student doesn't curate what's due,
 * the scheduler does. Picking *what's eligible at all* happens earlier and
 * separately, per card, via include_in_practice (set from Manage). Curating
 * *what to look at* without scheduling is what Study mode is for instead —
 * see studyMode.ts, which is where stack/tag selection actually lives now.
 */
export async function loadQueueForDeck(deck: Deck): Promise<CardWithNote[]> {
  const nowISO = new Date().toISOString();

  // Pull a larger due pool than we'll actually use (most-overdue-first, so
  // nothing genuinely stale gets starved), then shuffle and slice to the
  // daily limit. Slicing by due-order directly would grab whichever stack
  // happened to be reviewed together last time (they all come due together),
  // producing sessions dominated by one or two stacks.
  const dueQuery = supabase
    .from('cards')
    .select('*,import_pages(rendered_page_path)')
    .eq('deck_id', deck.id)
    .eq('include_in_practice', true)
    .neq('state', 'new')
    .lte('due', nowISO)
    .order('due', { ascending: true })
    .limit(deck.review_per_day * 5);
  const newQuery = supabase
    .from('cards')
    .select('*,import_pages(rendered_page_path)')
    .eq('deck_id', deck.id)
    .eq('include_in_practice', true)
    .eq('state', 'new')
    .order('created_at', { ascending: true })
    .limit(deck.new_per_day);

  const [dueRes, newRes] = await Promise.all([dueQuery, newQuery]);
  if (dueRes.error) throw dueRes.error;
  if (newRes.error) throw newRes.error;

  const dueCards = shuffle(dueRes.data).slice(0, deck.review_per_day);
  return shuffle([...dueCards, ...newRes.data]) as CardWithNote[];
}

/**
 * Global practice: every deck's due+new pool, pulled independently (each
 * deck keeps its own daily limits) and combined into one shuffled queue —
 * the cross-deck counterpart to loadQueueForDeck, same "zero configuration"
 * rule. Skips decks with nothing ready, so one slow query for an empty deck
 * never blocks the rest.
 */
export async function loadQueueAcrossAllDecks(decks: Deck[]): Promise<CardWithNote[]> {
  const queues = await Promise.all(decks.map((d) => loadQueueForDeck(d)));
  return shuffle(queues.flat());
}

/** Schedules the card via FSRS, persists the new card state, and logs the review. */
export async function commitGrade(card: Card, grade: Rating, retention: number): Promise<void> {
  const now = Date.now();
  const patch = scheduleCard(card, grade, retention, now);

  // .select('id') here is load-bearing, not cosmetic: a RLS policy that
  // filters out this row (e.g. the caller doesn't actually own the
  // underlying import for a textbook_extraction card) makes Postgres/
  // PostgREST return a *successful* response with zero rows affected — no
  // `error` at all. Without asking for the updated row back, that silent
  // no-op is indistinguishable from a real save: the toast says "graded",
  // the session advances, and the due date never actually moved, so the
  // card just comes back next queue pull looking exactly like the
  // scheduler is broken.
  const { data: updated, error: cardError } = await supabase.from('cards').update(patch).eq('id', card.id).select('id');
  if (cardError) throw cardError;
  if (!updated || updated.length === 0) {
    throw new Error('Grade did not save (no card row was updated — you may not have edit access to this card)');
  }

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
