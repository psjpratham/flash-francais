-- Read Mode extraction schema, step 1: richer per-block metadata for the
-- polished Read Mode renderer. Purely additive — every new column is
-- nullable or has a safe default, so existing page_blocks rows (extracted
-- under the old schema) remain valid as-is. Nothing here migrates or
-- rewrites old rows; the frontend's compatibility mapper (see
-- src/lib/legacyComponentMap.ts) maps old component_type values to their
-- closest new Read Mode component purely at render time.

alter table public.page_blocks
  add column if not exists section_number text,
  add column if not exists title text,
  add column if not exists instruction text,
  add column if not exists language text,
  add column if not exists answer_key_status text not null default 'unknown'
    check (answer_key_status in ('available', 'unavailable', 'unknown')),
  add column if not exists pronunciation_enabled boolean not null default false,
  add column if not exists activity_audio_reference jsonb;
