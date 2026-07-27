-- Page-first refactor, step 3: generic audio assets + two new private
-- storage buckets.
--
-- import_audio_files replaces the old corrige/transcription-as-supporting-
-- evidence model: an import can now have any number of generic audio files
-- (mp3/wav/m4a), matched to audio_ref blocks by normalised filename or
-- track number — never publisher-specific, never a hardcoded naming
-- convention. Matching itself (matched_audio_asset_id/confidence/
-- needs_review) lives inside the relevant audio_ref block's content jsonb,
-- not as a column here — this table only describes the uploaded file.

create table if not exists public.import_audio_files (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  original_filename text not null,
  normalized_filename text not null,
  track_number integer,
  storage_path text not null,
  duration numeric,
  created_at timestamptz not null default now()
);

create index if not exists import_audio_files_import_idx on public.import_audio_files (import_id);

alter table public.import_audio_files enable row level security;

create policy "import_audio_files_own" on public.import_audio_files
  for all
  using (
    public.is_admin()
    and exists (select 1 from public.imports i where i.id = import_audio_files.import_id and i.user_id = auth.uid())
  )
  with check (
    public.is_admin()
    and exists (select 1 from public.imports i where i.id = import_audio_files.import_id and i.user_id = auth.uid())
  );

-- ---------- storage buckets ----------
-- Same "<import_id>/<...>" key shape and RLS pattern as import-sources.

insert into storage.buckets (id, name, public)
values
  ('import-audio', 'import-audio', false),
  ('import-page-renders', 'import-page-renders', false)
on conflict (id) do nothing;

drop policy if exists "import_audio_own" on storage.objects;
create policy "import_audio_own" on storage.objects
  for all
  using (
    bucket_id = 'import-audio'
    and public.is_admin()
    and exists (
      select 1 from public.imports i
      where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'import-audio'
    and public.is_admin()
    and exists (
      select 1 from public.imports i
      where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid()
    )
  );

drop policy if exists "import_page_renders_own" on storage.objects;
create policy "import_page_renders_own" on storage.objects
  for all
  using (
    bucket_id = 'import-page-renders'
    and public.is_admin()
    and exists (
      select 1 from public.imports i
      where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'import-page-renders'
    and public.is_admin()
    and exists (
      select 1 from public.imports i
      where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid()
    )
  );
