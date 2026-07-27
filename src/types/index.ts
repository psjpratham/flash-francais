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

// ---------- profiles / roles ----------

export type UserRole = 'admin' | 'student';

export type Profile = {
  id: string;
  role: UserRole;
  created_at: string;
};

// ---------- decks ----------

export type DeckVisibility = 'shared' | 'personal';
export type DeckStatus = 'draft' | 'published';

export type Deck = {
  id: string;
  user_id: string;
  name: string;
  source: string;
  review_per_day: number;
  new_per_day: number;
  desired_retention: number;
  visibility: DeckVisibility;
  status: DeckStatus;
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

// ---------- review/confidence metadata ----------
// Real columns on notes (see migration 20260725070000).

export type ReviewStatus = 'approved' | 'needs_review';
export type Confidence = 'high' | 'medium' | 'low';

/** Where an extracted item came from in the source textbook, for traceability. */
export type SourceEvidence = {
  page?: number;
  corrigePage?: number;
  piste?: string;
};

/** Signals from the extraction process itself, not the content — used only for deterministic flagging. */
export type ExtractionDiagnostics = {
  schemaRetryCount?: number;
  unresolvedReferences?: string[];
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
  review_status: ReviewStatus;
  confidence: Confidence;
  review_reasons: string[];
  source_evidence: SourceEvidence | null;
  extraction_diagnostics: ExtractionDiagnostics | null;
  /** Set when this note was compiled from an imported page_block (see sendPageBlocksToPractice) — null for manually/paste/JSON-authored notes. Session rendering uses this to show the same split page-image view as the review UI, reusing the referenced block live rather than a snapshot. */
  source_block_id: string | null;
  created_at: string;
};

export type NoteInsert = Pick<Note, 'deck_id'> &
  Partial<
    Pick<
      Note,
      'note_type' | 'tags' | 'review_status' | 'confidence' | 'review_reasons' | 'source_evidence' | 'extraction_diagnostics' | 'source_block_id'
    >
  > &
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

/** The imported block a practice note was compiled from, joined in live at queue-load time (see loadQueueForDeck's NOTES_SELECT) — the full row (renderReadModeBlock needs it whole) plus its page's rendered image path, reused for the session's split view. Null for a manually-authored note. */
export type SourceBlockForSession = PageBlock & {
  import_pages: { rendered_page_path: string | null } | null;
};

/** A card joined with its parent note, as returned by the study-queue query. */
export type CardWithNote = Card & {
  notes: Pick<Note, 'fields' | 'note_type' | 'tags' | 'source_block_id'> & {
    page_blocks: SourceBlockForSession | null;
  };
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

// ---------- page blocks ----------
// The page is the only content unit — no chapter/lesson/section hierarchy.
// A block's `content` shape is determined by `component_type`; these types
// narrow it for the renderer, but the DB column itself is plain jsonb (see
// PageBlock below). Faithful extraction only: no answer keys are captured
// here (never "answer exercises") — those are a later, card-generation slice.

/** Component types written by pre-card-recipe extraction prompts — still valid on existing rows, mapped to their closest new recipe at render time (see src/lib/legacyComponentMap.ts). Never written by new extractions. */
export type LegacyDocumentComponentType = 'heading' | 'paragraph' | 'instruction' | 'dialogue' | 'vocabulary' | 'grammar' | 'example' | 'reference' | 'note' | 'table' | 'caption' | 'raw_text';
export type LegacyInteractionComponentType = 'multiple_choice' | 'fill_blank' | 'matching' | 'ordering' | 'writing' | 'speaking' | 'listening' | 'short_answer';
/** The intermediate (Read-Mode-v1, page-extraction-v2/v3) 26-type taxonomy — also legacy now, superseded by CardRecipe below, but still valid on rows extracted in that window. */
export type LegacyCardComponentType =
  | 'page_heading' | 'section_heading' | 'formatted_text' | 'reading_passage'
  | 'single_choice' | 'multi_select' | 'inline_fill_blank' | 'text_entry' | 'multi_text_entry'
  | 'long_writing' | 'short_answer' | 'dialogue_completion' | 'composed_activity';

// ---------- card recipes ----------
// A deliberately small, generic set of well-designed UI patterns — not a
// taxonomy of every textbook phrasing. `kind` (document/interaction/
// image_ref/audio_ref) still says broadly what a card is; `component_type`
// holds one of these recipes (or 'image_ref'/'audio_ref' for media kinds,
// unchanged) and says which UI pattern renders it. When nothing here fits,
// 'freeform' is the escape hatch (a small allowlisted primitive tree — see
// ComposedNode below), not a reason to force content into the wrong recipe.
export type CardRecipe =
  | 'text' // reading content: headings, passages, instructions, notes, examples — rich text, with an optional adjunct table
  | 'vocabulary' // a themed group of term/translation/example entries, purpose-built (not a generic table)
  | 'grammar_rule' // a rule statement + examples, purpose-built (not a generic paragraph)
  | 'table' // real tabular/grid data only
  | 'dialogue' // speaker turns, optionally with inline blanks to fill in
  | 'single_choice'
  | 'multi_select'
  | 'text_input' // one or more labeled answers, or inline blanks in a template — short or long
  | 'matching_pairs'
  | 'ordering'
  | 'categorize' // sort items into labeled groups (click an item, then click its group) — e.g. masculine/feminine, true/false-style bucketing beyond a simple binary
  | 'speaking'
  | 'listening'
  | 'freeform';

/** A closed set of semantic labels the model picks from — never CSS, never free text. Drives icon + accent color entirely owned by our own CSS (see readModeRenderers.ts); rejected the alternative (model-authored CSS) outright: CSS is a real exfiltration/injection surface (background:url(...), @import, unscoped rules reaching outside their own card) and a hand-rolled sanitizer for it is exactly the kind of thing that's easy to get subtly wrong. */
export type CardCategory = 'vocabulary' | 'grammar' | 'culture' | 'reading' | 'exercise' | 'audio' | 'writing' | null;

// ---------- controlled rich-text model (never raw HTML) ----------

export type RichTextSpan = { text: string; bold?: boolean; italic?: boolean };
export type RichTextNode = { type: 'paragraph' | 'list_item' | 'heading'; spans: RichTextSpan[] };
export type RichTextContent = { nodes: RichTextNode[] };

// ---------- composed_activity: a small, safe, allowlisted primitive tree ----------
// The model may compose ONLY from this fixed set — never arbitrary
// component names, HTML, CSS, or JS. See src/lib/composedActivity.ts for the
// validator that enforces this at render time (untrusted model output is
// never trusted structurally, even though it's already JSON-only).

export const COMPOSED_PRIMITIVE_TYPES = [
  'text',
  'rich_text',
  'label',
  'row',
  'column',
  'group',
  'divider',
  'badge',
  'short_input',
  'long_input',
  'radio_group',
  'checkbox_group',
  'option',
  'table',
  'spacer',
  'activity_audio_control',
  'pronunciation_control',
] as const;
export type ComposedPrimitiveType = (typeof COMPOSED_PRIMITIVE_TYPES)[number];

export type ComposedNode = {
  type: ComposedPrimitiveType;
  text?: string;
  richText?: RichTextContent;
  label?: string;
  id?: string;
  placeholder?: string;
  headers?: string[];
  rows?: string[][];
  children?: ComposedNode[];
};

export type PageComposedActivityContent = { root: ComposedNode };

// ---------- card recipe content shapes ----------
// One shape per recipe, each deliberately tolerant of the closest legacy
// shape too (old rows are never migrated/rewritten — see
// src/lib/legacyComponentMap.ts and the renderers' own tolerance).

/** 'text' recipe: nodes/text is the content itself; table is an optional adjunct (e.g. a grammar point with an example table below it); style is a soft cosmetic hint only — never changes the shape, never required. */
export type CardTextContent = { nodes?: RichTextNode[]; text?: string; table?: string[][]; style?: 'heading' | 'passage' | 'instruction' | 'example' | 'note' | null };
/** 'table' recipe: rows is the normal case; pairs tolerates the legacy vocabulary term/translation shape. */
export type CardTableContent = { headers?: string[]; rows?: string[][]; pairs?: { term: string; translation?: string }[] };
/** 'vocabulary' recipe: a themed group of terms — purpose-built layout (term prominent, pronunciation, translation, optional example), not a flat table. */
export type CardVocabularyContent = { title?: string | null; pairs: { term: string; translation?: string | null; example?: string | null }[] };
/** 'grammar_rule' recipe: one rule statement + its examples — purpose-built "rule box" layout, not a generic paragraph. */
export type CardGrammarRuleContent = { rule: string; examples?: string[] };
export type CardDialogueContent = { turns: { speaker: string | null; text: string }[] };
export type CardChoiceContent = { prompt: string; options: string[] };
export type CardTextInputField = { id: string; label?: string | null; prefix?: string | null; suffix?: string | null; placeholder?: string | null };
/** 'text_input' recipe: template (inline blanks) and fields (labeled slots) are alternatives — set whichever fits; long hints at a full textarea instead of a single-line input. */
export type CardTextInputContent = { prompt: string; template?: string | null; fields?: CardTextInputField[]; placeholder?: string | null; long?: boolean };
export type CardMatchingContent = { prompt?: string | null; left: string[]; right: string[] };
export type CardOrderingContent = { prompt?: string | null; items: string[] };
/** 'categorize' recipe: sort each item into one of the named groups (click an item, then click its group) — e.g. groups ["masculin","féminin"], items ["chanteur","chanteuse",...]. */
export type CardCategorizeContent = { prompt?: string | null; groups: string[]; items: string[] };
export type CardOpenTaskContent = { prompt: string; note?: string | null };

// Legacy (pre-card-recipe) content shapes — still read by blockRenderers.ts
// (Edit Mode, intentionally unchanged) and by already-extracted rows.
export type PageTextContent = { text: string };
export type PageRichTextContent = RichTextContent;
export type PageDialogueContent = { turns: { speaker: string | null; text: string }[] };
export type PageVocabularyContent = { pairs: { term: string; translation?: string }[] };
export type PageTableContent = { headers?: string[]; rows: string[][] };
export type PageGrammarContent = { text?: string; nodes?: RichTextNode[]; table?: string[][] };
export type PageFillBlankContent = { prompt?: string; template: string };
export type PageMultipleChoiceContent = { prompt: string; options: string[]; multi?: boolean };
export type PageMultiTextEntryField = CardTextInputField;
export type PageDialogueCompletionContent = { turns: { speaker: string | null; template: string }[] };

export type PageImageRefContent = {
  region?: { x: number; y: number; width: number; height: number } | null;
  caption?: string;
  parserId?: string;
};

export type PageAudioRefContent = {
  label: string;
  detectedTrackNumber?: string | null;
  matchedAudioAssetId?: string | null;
  matchConfidence?: Confidence | null;
};

export type PageBlockContent =
  | CardTextContent
  | CardVocabularyContent
  | CardGrammarRuleContent
  | CardTableContent
  | CardDialogueContent
  | CardChoiceContent
  | CardTextInputContent
  | CardMatchingContent
  | CardOrderingContent
  | CardCategorizeContent
  | CardOpenTaskContent
  | PageComposedActivityContent
  | PageTextContent
  | PageRichTextContent
  | PageDialogueContent
  | PageVocabularyContent
  | PageTableContent
  | PageGrammarContent
  | PageMultipleChoiceContent
  | PageFillBlankContent
  | PageDialogueCompletionContent
  | PageImageRefContent
  | PageAudioRefContent
  | Record<string, unknown>;

export type PageBlockKind = 'document' | 'interaction' | 'image_ref' | 'audio_ref';

/** Visual-only provisioning (section 8/9 of the Read Mode spec) — no grading, no real audio wiring in this slice. */
export type AnswerKeyStatus = 'available' | 'unavailable' | 'unknown';
export type ActivityAudioReference = { label: string; status: 'matched' | 'unresolved' | 'unavailable' } | null;

export type PageBlock = {
  id: string;
  page_extraction_id: string;
  page_id: string;
  order_index: number;
  kind: PageBlockKind;
  component_type: CardRecipe | LegacyCardComponentType | LegacyDocumentComponentType | LegacyInteractionComponentType | 'image_ref' | 'audio_ref' | string;
  /** Exercise/section number as printed on the page (e.g. "3"), for the card header — distinct from order_index. */
  section_number: string | null;
  title: string | null;
  instruction: string | null;
  /** BCP-47-ish language tag (e.g. "fr") — drives whether a pronunciation icon makes sense. */
  language: string | null;
  source_line_ids: string[];
  source_text: string;
  content: PageBlockContent;
  /** A faithful, natural English translation of the card's content, generated separately from source_text — never a substitute for it, always additional, shown behind a toggle. Null when not available (e.g. legacy rows extracted before this existed). */
  translation: string | null;
  /** A closed semantic label (see CardCategory) driving icon/accent decoration we fully own — never model-authored CSS. */
  category: CardCategory;
  /** Open, growing, multi-value topic/skill classification (e.g. "food-and-drink", "present-tense") — see the `tags` table and TAGS in pageExtraction.ts. Independent of category. */
  tags: string[];
  answer_key_status: AnswerKeyStatus;
  pronunciation_enabled: boolean;
  activity_audio_reference: ActivityAudioReference;
  needs_review: boolean;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PageBlockInsert = Pick<PageBlock, 'page_extraction_id' | 'page_id' | 'order_index' | 'kind' | 'component_type'> &
  Partial<
    Pick<
      PageBlock,
      | 'section_number'
      | 'title'
      | 'instruction'
      | 'language'
      | 'source_line_ids'
      | 'source_text'
      | 'content'
      | 'translation'
      | 'category'
      | 'tags'
      | 'answer_key_status'
      | 'pronunciation_enabled'
      | 'activity_audio_reference'
      | 'needs_review'
      | 'review_reason'
    >
  >;

export type PageBlockUpdate = Partial<
  Pick<
    PageBlock,
    | 'order_index'
    | 'kind'
    | 'component_type'
    | 'section_number'
    | 'title'
    | 'instruction'
    | 'language'
    | 'source_line_ids'
    | 'source_text'
    | 'content'
    | 'translation'
    | 'category'
    | 'answer_key_status'
    | 'pronunciation_enabled'
    | 'activity_audio_reference'
    | 'needs_review'
    | 'review_reason'
  >
>;

// ---------- page extractions ----------

export type PageExtractionStatus = 'pending' | 'processing' | 'needs_review' | 'approved' | 'failed';

/** One line-coverage/fidelity problem found by the deterministic checker or the audit prompt. */
export type PageWarning = {
  code: string;
  message: string;
  source_line_ids?: string[];
};

export type PageCoverageResult = {
  missingLineIds: string[];
  duplicatedLineIds: string[];
  alteredText: { lineIds: string[]; issue: string }[];
  orderingIssues: string[];
  invalidLineReferences: string[];
};

export type PageAuditResult = {
  passed: boolean;
  missing_line_ids: string[];
  duplicated_line_ids: string[];
  altered_text: { line_ids: string[]; issue: string }[];
  ordering_issues: string[];
  incorrect_component_mappings: string[];
  invented_content: string[];
  missing_image_refs: string[];
  missing_audio_refs: string[];
  repair_instructions: string[];
};

export type PageRepairAttempt = {
  attempt: number;
  timestamp: string;
  issuesBefore: string[];
  issuesAfter: string[];
};

export type PageExtraction = {
  id: string;
  page_id: string;
  version: number;
  status: PageExtractionStatus;
  model: string | null;
  prompt_version: string | null;
  raw_model_response: Record<string, unknown> | null;
  model_warnings: PageWarning[];
  coverage_result: PageCoverageResult | null;
  audit_result: PageAuditResult | null;
  repair_history: PageRepairAttempt[];
  unresolved_warnings: PageWarning[];
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  /** True when approved despite unresolved warnings — an explicit admin override, never silent. */
  approved_with_warnings: boolean;
  approval_override_reason: string | null;
};

// ---------- image regions (detected on the page, independent of extraction) ----------

export type ImageRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  parserId?: string;
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

// ---------- imports ----------

/** Only 'textbook' is written by the current (page-first) import flow — 'corrige'/'transcription' are retained in the check constraint only for old rows, never offered in the UI. */
export type ImportSourceType = 'textbook' | 'corrige' | 'transcription';
export type ImportFileStatus = 'idle' | 'uploading' | 'completed' | 'failed';

/**
 * Coarse pipeline stage, persisted server-side and updated only by the
 * durable dispatcher/workers (a service-role client — never the browser).
 * 'completed' is only ever set by approve_page_extraction once every page
 * is reviewed; everything else is set by the preprocess/extract workers.
 */
export type ImportStatus = 'uploaded' | 'preprocessing' | 'extracting' | 'needs_review' | 'completed' | 'completed_with_errors' | 'failed';

export type Import = {
  id: string;
  user_id: string;
  deck_id: string;
  title: string;
  status: ImportStatus;
  total_pages: number | null;
  pages_discovered: number;
  pages_prepared: number;
  pages_failed_preprocessing: number;
  /** 0-based index of the page currently being preprocessed, null when not actively preprocessing. */
  current_page_index: number | null;
  preprocessing_error: string | null;
  /** Heartbeat — bumped on every meaningful persisted change; used to detect "no progress for N minutes". */
  last_progress_at: string | null;
  /** Admin-set test toggle: forces every page through image-only extraction (ignoring any embedded PDF text layer) — see preprocessWorker.ts. */
  force_image_only: boolean;
  created_at: string;
  updated_at: string;
};

export type ImportInsert = Pick<Import, 'deck_id' | 'title'> & Partial<Pick<Import, 'force_image_only'>>;

export type ImportFile = {
  id: string;
  import_id: string;
  source_type: ImportSourceType;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  status: ImportFileStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ImportFileInsert = Pick<ImportFile, 'import_id' | 'source_type' | 'storage_path' | 'filename'> &
  Partial<Pick<ImportFile, 'mime_type' | 'size_bytes' | 'status'>>;

export type ImportFileUpdate = Partial<Pick<ImportFile, 'status' | 'error' | 'size_bytes' | 'mime_type'>>;

/** One page of the textbook PDF — the only content unit. Mechanical text/region extraction only; model-based extraction is a separate, later step (see PageExtraction). */
export type ExtractionStatus = 'extracted' | 'empty' | 'image_only' | 'unreadable';

export type ImportPage = {
  id: string;
  import_id: string;
  import_file_id: string | null;
  source_type: ImportSourceType;
  filename: string;
  /** 0-based position of this page within the source PDF. */
  page_index: number;
  /** The page number printed on the page itself, when determinable — distinct from page_index. */
  displayed_page_number: number | null;
  text: string | null;
  extraction_status: ExtractionStatus;
  error: string | null;
  /** Storage path of the rasterized page image, filled in by client-side rendering after preprocessing. */
  rendered_page_path: string | null;
  width: number | null;
  height: number | null;
  /** Best-effort image XObject bounding boxes detected in the PDF's content stream. */
  image_regions: ImageRegion[];
  /** Storage path (import-page-pdfs bucket) of this page sliced into its own single-page PDF — a byte-faithful copy, never a crop or recreation — attached to the extraction call as visual/structural context. Null when slicing failed (extraction then falls back to text-only). */
  page_pdf_path: string | null;
  created_at: string;
  updated_at: string;
};

export type ImportAudioFile = {
  id: string;
  import_id: string;
  original_filename: string;
  normalized_filename: string;
  track_number: number | null;
  storage_path: string;
  duration: number | null;
  created_at: string;
};

export type ImportAudioFileInsert = Pick<ImportAudioFile, 'import_id' | 'original_filename' | 'normalized_filename' | 'storage_path'> &
  Partial<Pick<ImportAudioFile, 'track_number' | 'duration'>>;


// ---------- jobs ----------

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

/** Open-ended: no fixed job type set exists yet (import pipeline is a later slice). */
export type JobType = string;

export type Job = {
  id: string;
  user_id: string;
  deck_id: string | null;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  attempt_count: number;
};

export type JobInsert = Pick<Job, 'type'> & Partial<Pick<Job, 'deck_id' | 'payload'>>;

// ---------- Supabase Database generic ----------

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Pick<Profile, 'id'> & Partial<Pick<Profile, 'role'>>;
        Update: Partial<Pick<Profile, 'role'>>;
        Relationships: [];
      };
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
          {
            foreignKeyName: 'notes_source_block_id_fkey';
            columns: ['source_block_id'];
            isOneToOne: false;
            referencedRelation: 'page_blocks';
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
      jobs: {
        Row: Job;
        Insert: JobInsert;
        Update: Partial<Pick<Job, 'status' | 'result' | 'error' | 'completed_at' | 'started_at' | 'attempt_count'>>;
        Relationships: [
          {
            foreignKeyName: 'jobs_deck_id_fkey';
            columns: ['deck_id'];
            isOneToOne: false;
            referencedRelation: 'decks';
            referencedColumns: ['id'];
          },
        ];
      };
      imports: {
        Row: Import;
        Insert: ImportInsert;
        Update: Partial<
          Pick<
            Import,
            | 'title'
            | 'status'
            | 'total_pages'
            | 'pages_discovered'
            | 'pages_prepared'
            | 'pages_failed_preprocessing'
            | 'current_page_index'
            | 'preprocessing_error'
            | 'last_progress_at'
          >
        >;
        Relationships: [
          {
            foreignKeyName: 'imports_deck_id_fkey';
            columns: ['deck_id'];
            isOneToOne: false;
            referencedRelation: 'decks';
            referencedColumns: ['id'];
          },
        ];
      };
      import_files: {
        Row: ImportFile;
        Insert: ImportFileInsert;
        Update: ImportFileUpdate;
        Relationships: [
          {
            foreignKeyName: 'import_files_import_id_fkey';
            columns: ['import_id'];
            isOneToOne: false;
            referencedRelation: 'imports';
            referencedColumns: ['id'];
          },
        ];
      };
      import_pages: {
        Row: ImportPage;
        Insert: Omit<ImportPage, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<
          Pick<ImportPage, 'text' | 'extraction_status' | 'error' | 'rendered_page_path' | 'width' | 'height' | 'image_regions' | 'displayed_page_number'>
        >;
        Relationships: [
          {
            foreignKeyName: 'import_pages_import_id_fkey';
            columns: ['import_id'];
            isOneToOne: false;
            referencedRelation: 'imports';
            referencedColumns: ['id'];
          },
        ];
      };
      import_audio_files: {
        Row: ImportAudioFile;
        Insert: ImportAudioFileInsert;
        Update: Partial<Pick<ImportAudioFile, 'track_number' | 'duration'>>;
        Relationships: [
          {
            foreignKeyName: 'import_audio_files_import_id_fkey';
            columns: ['import_id'];
            isOneToOne: false;
            referencedRelation: 'imports';
            referencedColumns: ['id'];
          },
        ];
      };
      page_extractions: {
        Row: PageExtraction;
        Insert: Partial<PageExtraction> & Pick<PageExtraction, 'page_id' | 'version'>;
        Update: Partial<
          Pick<
            PageExtraction,
            | 'status'
            | 'model'
            | 'prompt_version'
            | 'raw_model_response'
            | 'model_warnings'
            | 'coverage_result'
            | 'audit_result'
            | 'repair_history'
            | 'unresolved_warnings'
            | 'reviewed_at'
            | 'reviewed_by'
          >
        >;
        Relationships: [
          {
            foreignKeyName: 'page_extractions_page_id_fkey';
            columns: ['page_id'];
            isOneToOne: false;
            referencedRelation: 'import_pages';
            referencedColumns: ['id'];
          },
        ];
      };
      page_blocks: {
        Row: PageBlock;
        Insert: PageBlockInsert;
        Update: PageBlockUpdate;
        Relationships: [
          {
            foreignKeyName: 'page_blocks_page_extraction_id_fkey';
            columns: ['page_extraction_id'];
            isOneToOne: false;
            referencedRelation: 'page_extractions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'page_blocks_page_id_fkey';
            columns: ['page_id'];
            isOneToOne: false;
            referencedRelation: 'import_pages';
            referencedColumns: ['id'];
          },
        ];
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
      claim_jobs: {
        Args: { p_type: string; p_limit?: number };
        Returns: Job[];
      };
      complete_job: {
        Args: { p_job_id: string; p_result?: Record<string, unknown> };
        Returns: Job;
      };
      fail_job: {
        Args: { p_job_id: string; p_error: string };
        Returns: Job;
      };
      approve_page_extraction: {
        Args: { p_page_extraction_id: string; p_force?: boolean; p_override_reason?: string | null };
        Returns: PageExtraction;
      };
    };
  };
};
