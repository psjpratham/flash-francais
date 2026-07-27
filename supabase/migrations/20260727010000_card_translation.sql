-- Card-recipe extraction, step 2: a per-card English translation field.
-- Purely additive and nullable — existing rows (extracted before this
-- existed) simply have translation = null, which the frontend renders as
-- "no translation available" rather than a missing/broken toggle. Kept
-- entirely separate from source_text, which stays the sole verbatim record
-- of the original French wording; translation is generated content, never
-- a substitute for it.

alter table public.page_blocks
  add column if not exists translation text;
