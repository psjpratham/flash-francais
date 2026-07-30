-- Multi-source imports sharing one stack, for source types with no inherent
-- page structure.
--
-- import_files already allows more than one 'textbook'-typed row per import
-- (no unique constraint ever existed on (import_id, source_type)) — only the
-- application code assumed exactly one. preprocessWorker.ts now processes
-- every uploaded source file as its own sequence of "generation units"
-- (a PDF's pages, or a single image/text file's one page), all sharing one
-- global, resumable page_index counter across files.
--
-- merged_stack_id: deterministic, not a user choice — set once, at import
-- creation, only when the import's source is image-only (no real page
-- concept, so every unit's cards should land in one shared stack instead of
-- one stack per unit). Null for pdf/doc imports, which keep the unchanged
-- one-stack-per-page default. The shared stack is created once, up front
-- (see lib/imports.ts's createImport), reused by every one of this import's
-- generation units instead of each creating its own. The original per-unit
-- stacks rows still exist either way (see extractWorker.ts) — they keep
-- tracking that unit's own extraction attempt/status/warnings exactly as
-- before; merged_stack_id only changes which stack the resulting CARDS get
-- filed under, never how each unit is processed or reviewed.

alter table public.imports
  add column if not exists merged_stack_id uuid references public.stacks(id) on delete set null;
