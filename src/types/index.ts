/**
 * Hand-written types matching the live Supabase schema, reverse-engineered
 * from the old flashcards.html prototype's REST/RPC calls (supabase db pull
 * can't run here — Docker has no shadow-DB room). Re-generate with the
 * Supabase CLI (`supabase gen types typescript`) once disk space allows, and
 * this file can be replaced/reconciled against the real output.
 *
 * NOTE: every type that ends up as a Row/Insert/Update/Args in the Database
 * generic below is declared with `type`, not `interface`. Object type
 * literals get an implicit string index signature when checked against
 * postgrest-js's `Record<string, GenericTable>` constraints; named
 * interfaces never do, even when nested, and fail that check.
 */

// ---------- FSRS ----------

/** FSRS-5 grade: 1=Again, 2=Hard, 3=Good, 4=Easy */
export type Rating = 1 | 2 | 3 | 4;

export type CardState = 'new' | 'learning' | 'review' | 'relearning';

// ---------- decks ----------

export type Deck = {
  id: string;
  user_id: string;
  name: string;
  source: string;
  review_per_day: number;
  new_per_day: number;
  desired_retention: number;
  created_at: string;
};

export type DeckInsert = Pick<Deck, 'name'> &
  Partial<Omit<Deck, 'id' | 'user_id' | 'name' | 'created_at'>>;

export type DeckUpdate = Partial<Omit<Deck, 'id' | 'user_id' | 'created_at'>>;

/** Client-side aggregate stitched onto a Deck row after loading counts (not a DB column). */
export type DeckWithCounts = Deck & {
  _due: number;
  _new: number;
};

// ---------- notes ----------

export type NoteType =
  | 'basic'
  | 'vocab'
  | 'anki'
  | 'grammar'
  | 'phrase'
  | 'culture'
  | 'phonetics';

export type ExamplePair = {
  fr: string;
  en: string;
  source?: 'generated';
};

/**
 * The `fields` jsonb column shape varies by note_type (see PROFILES in the
 * old prototype). All fields are optional; unknown extra fields pass through.
 */
export type NoteFields = {
  front?: string;
  back?: string;
  Front?: string;
  Back?: string;
  image?: string;
  audio?: string;
  piste?: string;
  gender?: string;
  examples?: ExamplePair[] | [string, string];
  note?: string;
  tip?: string;
  ipa?: string;
  decl?: string;
  wiktionary?: string;
  rule?: string;
  table?: string[][];
  register?: string;
  reply?: [string, string];
  detail?: string;
  letters?: string;
  [key: string]: unknown;
};

export type Note = {
  id: string;
  deck_id: string;
  note_type: NoteType;
  tags: string[];
  fields: NoteFields;
  created_at: string;
};

export type NoteInsert = Pick<Note, 'deck_id'> &
  Partial<Pick<Note, 'note_type' | 'tags'>> &
  Pick<Note, 'fields'>;

// ---------- cards ----------

export type Card = {
  id: string;
  note_id: string;
  deck_id: string;
  state: CardState;
  due: string;
  difficulty: number;
  stability: number;
  reps: number;
  lapses: number;
  step: number;
  last_review: string | null;
  created_at: string;
};

export type CardInsert = Pick<Card, 'note_id' | 'deck_id'> &
  Partial<Omit<Card, 'id' | 'note_id' | 'deck_id' | 'created_at'>>;

export type CardUpdate = Partial<
  Pick<
    Card,
    'state' | 'due' | 'difficulty' | 'stability' | 'reps' | 'lapses' | 'step' | 'last_review'
  >
>;

/** A card joined with its parent note, as returned by the study-queue query. */
export type CardWithNote = Card & {
  notes: Pick<Note, 'fields' | 'note_type' | 'tags'>;
};

// ---------- review_log ----------

export type ReviewLog = {
  id: string;
  card_id: string;
  rating: Rating;
  state_before: CardState;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  reviewed_at: string;
};

export type ReviewLogInsert = Pick<
  ReviewLog,
  'card_id' | 'rating' | 'state_before' | 'stability' | 'difficulty' | 'elapsed_days'
>;

// ---------- book_lessons ----------

export type BookDocType =
  | 'social-post'
  | 'forum-post'
  | 'email'
  | 'dialogue'
  | 'webpage'
  | 'captioned-photos'
  | 'audio-message'
  | string;

export type BookDocumentBlock = {
  type: 'document';
  docType: BookDocType;
  title: string;
  body: string;
  image?: string;
  audio?: string;
};

export type BookReferenceBlock = {
  type: 'reference';
  title: string;
  body: string | string[][];
};

export type BookCultureBlock = {
  type: 'culture';
  title: string;
  body: string;
};

export type BookMatchItem = string | { label: string; image?: string };

type BookActivityBase = {
  type: 'activity';
  id: string;
  prompt: string;
  note?: string;
  sourceRef?: string;
  audio?: string;
};

export type BookActivityRead = BookActivityBase & {
  interaction: 'read';
};
export type BookActivityProduce = BookActivityBase & {
  interaction: 'produce';
};
export type BookActivitySelect = BookActivityBase & {
  interaction: 'select';
  options: string[];
  multi?: boolean;
  answerKey: string | string[];
};
export type BookActivityHighlight = BookActivityBase & {
  interaction: 'highlight';
  text: string;
  correctSpans: string[];
};
export type BookActivityMatch = BookActivityBase & {
  interaction: 'match';
  left: BookMatchItem[];
  right: BookMatchItem[];
  answerKey: Record<string, string>;
};
export type BookActivityFillblank = BookActivityBase & {
  interaction: 'fillblank';
  template: string;
  answer: string;
};
export type BookActivityTrueFalse = BookActivityBase & {
  interaction: 'truefalse';
  answer: boolean;
};
export type BookActivityOrder = BookActivityBase & {
  interaction: 'order';
  items: string[];
  correctOrder: string[];
};

export type BookActivityBlock =
  | BookActivityRead
  | BookActivityProduce
  | BookActivitySelect
  | BookActivityHighlight
  | BookActivityMatch
  | BookActivityFillblank
  | BookActivityTrueFalse
  | BookActivityOrder;

export type BookBlock =
  | BookDocumentBlock
  | BookReferenceBlock
  | BookCultureBlock
  | BookActivityBlock;

export type BookSection = {
  title: string;
  blocks: BookBlock[];
};

export type BookContent = {
  sections: BookSection[];
};

export type BookLesson = {
  id: string;
  lesson_number: number | null;
  title: string;
  subtitle: string | null;
  order_index: number;
  content: BookContent;
};

// ---------- RPC return shapes ----------

export type RatingCounts = {
  again: number;
  hard: number;
  good: number;
  easy: number;
};

export type DeckStats = {
  reviews: { today: number; week: number; all: number };
  due: { now: number; week: number };
  cards: { new: number; learning: number; review: number; relearning: number; total: number };
  ratingsToday: RatingCounts;
  ratingsAll: RatingCounts;
  avgStability: number | null;
  avgDifficulty: number | null;
};

export type Streak = {
  current: number;
  longest: number;
};

/** `DeckStats` plus the streak, as assembled client-side (not a single RPC). */
export type DeckStatsWithStreak = DeckStats & {
  streak: Streak;
};

export type DeckTagCount = {
  tag: string;
  count: number;
};

// ---------- Supabase Database generic ----------

export type Database = {
  public: {
    Tables: {
      decks: {
        Row: Deck;
        Insert: DeckInsert;
        Update: DeckUpdate;
        Relationships: [];
      };
      notes: {
        Row: Note;
        Insert: NoteInsert;
        Update: Partial<NoteInsert>;
        Relationships: [
          {
            foreignKeyName: 'notes_deck_id_fkey';
            columns: ['deck_id'];
            isOneToOne: false;
            referencedRelation: 'decks';
            referencedColumns: ['id'];
          },
        ];
      };
      cards: {
        Row: Card;
        Insert: CardInsert;
        Update: CardUpdate;
        Relationships: [
          {
            foreignKeyName: 'cards_note_id_fkey';
            columns: ['note_id'];
            isOneToOne: false;
            referencedRelation: 'notes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cards_deck_id_fkey';
            columns: ['deck_id'];
            isOneToOne: false;
            referencedRelation: 'decks';
            referencedColumns: ['id'];
          },
        ];
      };
      review_log: {
        Row: ReviewLog;
        Insert: ReviewLogInsert;
        Update: Partial<ReviewLogInsert>;
        Relationships: [
          {
            foreignKeyName: 'review_log_card_id_fkey';
            columns: ['card_id'];
            isOneToOne: false;
            referencedRelation: 'cards';
            referencedColumns: ['id'];
          },
        ];
      };
      book_lessons: {
        Row: BookLesson;
        Insert: Partial<BookLesson> & Pick<BookLesson, 'title' | 'content'>;
        Update: Partial<BookLesson>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_stats: {
        Args: { p_deck_id: string | null };
        Returns: DeckStats;
      };
      get_streak: {
        Args: Record<string, never>;
        Returns: Streak;
      };
      get_deck_tags: {
        Args: { p_deck_id: string };
        Returns: DeckTagCount[];
      };
    };
  };
};
