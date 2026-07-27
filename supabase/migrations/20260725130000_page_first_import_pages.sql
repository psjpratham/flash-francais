-- Page-first refactor, step 1: import_pages becomes the real page registry.
--
-- chunk_index was "ordering fallback for sources without real pages" (plain
-- text). The new pipeline only ever preprocesses a paginated PDF textbook —
-- corrigé/transcription and plain-text chunking are dropped (see the import
-- flow changes) — so chunk_index's actual meaning has always been "the
-- page's position", and it's renamed to say so. displayed_page_number is the
-- number printed on the page itself (often offset from page_index), kept
-- separate and nullable since it isn't always determinable mechanically.
--
-- rendered_page_path/width/height are filled in by a client-side rendering
-- step after preprocessing (Edge Functions have no canvas), so they start
-- null and are updated in place by the browser via ordinary RLS-scoped
-- updates — no new RPC needed for that.

alter table public.import_pages rename column chunk_index to page_index;

alter table public.import_pages
  add column if not exists displayed_page_number integer,
  add column if not exists rendered_page_path text,
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists image_regions jsonb not null default '[]',
  add column if not exists updated_at timestamptz not null default now();

-- Idempotent preprocessing: re-running preprocess-import for an import must
-- upsert, never duplicate, a page row.
alter table public.import_pages
  add constraint import_pages_import_page_idx unique (import_id, page_index);
