import { supabase } from './supabase';

export type StackSummaryKind = 'page' | 'custom';

export interface StackSummary {
  id: string;
  name: string;
  kind: StackSummaryKind;
  status: string;
  /** Only set for kind='page' — the import_page this stack was extracted from (needed to jump straight into Manage/Edit/Review scoped to that page). */
  sourcePageId: string | null;
  /** The import this stack belongs to, when it's traceable to one — either a kind='page' stack (via its source page) or a kind='custom' stack that's some import's shared merged_stack_id (an image-source import — see createImport in imports.ts). Null only for a genuinely standalone custom stack (the "Manual cards" bucket). Used to group both kinds under the same "Stacks from {importTitle}" heading, rather than lumping an image import in with hand-made stacks just because both happen to be kind='custom'. */
  importId: string | null;
  importTitle: string | null;
  /** Only set for kind='page' — the page's position within its import, so a group's stacks sort in reading order. */
  pageIndex: number | null;
  cardCount: number;
  includedCount: number;
  /** Included cards that are actually ready for Practice right now (new, or due) — the same eligibility loadQueueForDeck uses, surfaced per stack so the Stacks browser shows where today's practice pool is coming from without letting you filter Practice itself. */
  readyCount: number;
}

/** Every stack in a deck (Page Stacks + Custom Stacks), each with its card counts — the data backing the Stacks browser. */
export async function listStacksForDeck(deckId: string): Promise<StackSummary[]> {
  const [{ data: allStackRows, error }, { data: mergedImportRows, error: mergedImportError }] = await Promise.all([
    supabase
      .from('stacks')
      .select('id, name, kind, status, source_page_id, version, import_pages(import_id, page_index, imports(title))')
      .eq('deck_id', deckId)
      .order('kind', { ascending: true })
      .order('created_at', { ascending: true }),
    // Image-source imports file every unit's cards into one shared kind='custom' stack (imports.merged_stack_id) with
    // no source_page_id of its own — this is the only other way (besides source_page_id) a stack traces back to an import.
    supabase.from('imports').select('id, title, merged_stack_id').eq('deck_id', deckId).not('merged_stack_id', 'is', null),
  ]);
  if (error) throw error;
  if (mergedImportError) throw mergedImportError;
  if (!allStackRows?.length) return [];

  // A retried page's extraction attempt is a brand-new `stacks` row (higher
  // version), never an update of the old one — the old 'failed' row is left
  // behind forever. Keep only each page's latest-version row (mirrors
  // getPageReviewCounts' dedup in pageExtractions.ts), so a stale failed
  // attempt from before a successful retry stops being counted. A kind=
  // 'custom' stack has no source_page_id and is never re-versioned, so it's
  // always kept as-is.
  const latestByPage = new Map<string, (typeof allStackRows)[number]>();
  const stackRows: typeof allStackRows = [];
  for (const s of allStackRows) {
    if (!s.source_page_id) {
      stackRows.push(s);
      continue;
    }
    const current = latestByPage.get(s.source_page_id);
    if (!current || s.version > current.version) latestByPage.set(s.source_page_id, s);
  }
  stackRows.push(...latestByPage.values());

  const importByMergedStackId = new Map((mergedImportRows ?? []).map((i) => [i.merged_stack_id as string, { id: i.id as string, title: i.title as string }]));

  const { data: cardRows, error: cardsError } = await supabase
    .from('cards')
    .select('stack_id, include_in_practice, state, due')
    .in(
      'stack_id',
      stackRows.map((s) => s.id),
    );
  if (cardsError) throw cardsError;

  const nowISO = new Date().toISOString();
  const counts = new Map<string, { total: number; included: number; ready: number }>();
  for (const c of cardRows ?? []) {
    const cur = counts.get(c.stack_id) ?? { total: 0, included: 0, ready: 0 };
    cur.total++;
    if (c.include_in_practice) {
      cur.included++;
      if (c.state === 'new' || c.due <= nowISO) cur.ready++;
    }
    counts.set(c.stack_id, cur);
  }

  return stackRows.map((s) => {
    const importPage = s.import_pages as { import_id: string; page_index: number; imports: { title: string } | null } | null;
    const mergedImport = s.kind === 'custom' ? importByMergedStackId.get(s.id) : undefined;
    const c = counts.get(s.id);
    return {
      id: s.id,
      name: s.name,
      kind: s.kind as StackSummaryKind,
      status: s.status,
      sourcePageId: s.source_page_id,
      importId: importPage?.import_id ?? mergedImport?.id ?? null,
      importTitle: importPage?.imports?.title ?? mergedImport?.title ?? null,
      pageIndex: importPage?.page_index ?? null,
      cardCount: c?.total ?? 0,
      includedCount: c?.included ?? 0,
      readyCount: c?.ready ?? 0,
    };
  });
}

/**
 * One import = one tile — regardless of how many underlying `stacks` rows
 * back it internally (a pdf/doc import still has one per page, purely for
 * extraction-attempt bookkeeping; an image import has one shared stack).
 * That internal split was never meant to be user-facing: browsing page by
 * page for a pdf/doc import already happens one level up, inside page
 * review itself (Prev/Next stack), so the Stacks/Study browsers only ever
 * need to show — and let you act on — the one thing each import actually
 * is. A tile with `isImport: false` is the one genuine exception: a
 * standalone hand-made stack (the "Manual cards" bucket) with no import
 * behind it at all.
 */
export interface StackTile {
  /** An import's id for an import-backed tile; the stack's own id for a hand-made one. */
  id: string;
  name: string;
  isImport: boolean;
  /** Worst-of status across the import's underlying stacks ('failed' > 'processing'/'pending' > everything else) — meaningless for a hand-made tile. */
  status: string;
  cardCount: number;
  includedCount: number;
  readyCount: number;
  /** Every underlying `stacks.id` this tile represents — what Study mode actually selects; always length 1 for a hand-made tile. */
  stackIds: string[];
  /** One representative source page to open page review at — null only for a hand-made tile (nothing to review there). */
  representativeSourcePageId: string | null;
  /** How many of the import's underlying page-attempts failed outright — surfaced so a partially-failed pdf/doc import is still visible as a problem worth a look, even though it's one tile now. */
  failedCount: number;
}

const STATUS_RANK: Record<string, number> = { failed: 2, processing: 1, pending: 1 };

/** Aggregates listStacksForDeck's per-row data into one tile per import (see StackTile) — the shape both the Manage and Study browsers actually want. */
export async function listStackTilesForDeck(deckId: string): Promise<StackTile[]> {
  const rows = await listStacksForDeck(deckId);
  const byImport = new Map<string, StackSummary[]>();
  const handMade: StackSummary[] = [];
  for (const s of rows) {
    if (!s.importId) {
      handMade.push(s);
      continue;
    }
    const group = byImport.get(s.importId) ?? [];
    group.push(s);
    byImport.set(s.importId, group);
  }

  const importTiles: StackTile[] = [...byImport.entries()].map(([importId, group]) => {
    // A kind='custom' stack's own `status` (an image import's shared merged
    // stack) is set once at creation and never updated afterward by the
    // extraction pipeline — only a kind='page' stack's status is ever
    // authoritative. Folding a custom stack's stale status into "worst"
    // pins the tile at "extracting…" forever even once every page is done.
    // A group with no page-kind stack at all (a pure image import) has
    // nothing real to report, so it defaults to a status outside
    // STATUS_RANK — no badge, same as "done".
    const pageStacks = group.filter((s) => s.kind === 'page');
    const worstStatus = pageStacks.length
      ? pageStacks.reduce((worst, s) => ((STATUS_RANK[s.status] ?? 0) > (STATUS_RANK[worst] ?? 0) ? s.status : worst), pageStacks[0].status)
      : 'extracted';
    return {
      id: importId,
      name: group[0].importTitle ?? 'Untitled import',
      isImport: true,
      status: worstStatus,
      cardCount: group.reduce((sum, s) => sum + s.cardCount, 0),
      includedCount: group.reduce((sum, s) => sum + s.includedCount, 0),
      readyCount: group.reduce((sum, s) => sum + s.readyCount, 0),
      stackIds: group.map((s) => s.id),
      representativeSourcePageId: group.find((s) => s.sourcePageId)?.sourcePageId ?? null,
      failedCount: group.filter((s) => s.status === 'failed').length,
    };
  });
  // Stacks arrive ordered by created_at ascending — the last-seen import is the most recent one, so put it first.
  importTiles.reverse();

  const handMadeTiles: StackTile[] = handMade.map((s) => ({
    id: s.id,
    name: s.name,
    isImport: false,
    status: s.status,
    cardCount: s.cardCount,
    includedCount: s.includedCount,
    readyCount: s.readyCount,
    stackIds: [s.id],
    representativeSourcePageId: null,
    failedCount: s.status === 'failed' ? 1 : 0,
  }));

  return [...importTiles, ...handMadeTiles];
}

export interface StackCardTags {
  stackId: string;
  tags: string[];
}

/** Every card's stack_id + tags for a deck, in one shot — lets the Study picker recompute each stack's tag-filtered card count entirely client-side as tag chips toggle, instead of re-querying on every click. */
export async function listCardTagsForDeck(deckId: string): Promise<StackCardTags[]> {
  const { data, error } = await supabase.from('cards').select('stack_id, tags').eq('deck_id', deckId);
  if (error) throw error;
  return (data ?? []).map((c) => ({ stackId: c.stack_id, tags: c.tags ?? [] }));
}

export async function renameStack(stackId: string, name: string): Promise<void> {
  const { error } = await supabase.from('stacks').update({ name }).eq('id', stackId);
  if (error) throw error;
}

export interface StackDetail {
  id: string;
  name: string;
  kind: StackSummaryKind;
  /** Only set for a Page Stack whose page has been rasterized — the split-view image for Study mode. */
  renderedPagePath: string | null;
}

/** One stack's identity + (for a Page Stack) its source page's rendered image path — everything Study mode needs besides the cards themselves (see listPageBlocks). */
export async function getStackById(stackId: string): Promise<StackDetail> {
  const { data, error } = await supabase
    .from('stacks')
    .select('id, name, kind, import_pages(rendered_page_path)')
    .eq('id', stackId)
    .single();
  if (error) throw error;
  return {
    id: data.id,
    name: data.name,
    kind: data.kind as StackSummaryKind,
    renderedPagePath: (data.import_pages as { rendered_page_path: string | null } | null)?.rendered_page_path ?? null,
  };
}
