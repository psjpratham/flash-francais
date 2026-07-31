-- Opens textbook import/extraction capability to every authenticated user
-- (previously admin-only), WITHOUT retiring the admin/student role
-- distinction itself — is_admin() stays a real check against profiles.role,
-- unchanged, because the role is still meaningful: it gates the admin-only
-- monitoring/diagnostics UI today, and is the natural place to re-restrict
-- import capability later (a feature flag, or just adding `and
-- public.is_admin()` back to the handful of policies below) without having
-- to redesign the role model from scratch.
--
-- Every policy touched below previously required `is_admin() AND you-own-
-- the-row` — this drops just the is_admin() half, leaving ownership as the
-- sole gate. Nothing here changes decks_insert/decks_update's admin gate on
-- visibility='shared' (the curated-deck system stays admin-only) or
-- anything about public/personal decks.

-- ---------- drop the superseded SQL-only clone RPC ----------
-- An earlier migration (20260811000000, since deleted before ever shipping)
-- added a clone_public_deck() RPC that only copied manual-origin cards and
-- couldn't touch Storage bytes at all. It was replaced by the
-- clone-public-deck edge function (full-fidelity copy, incl. images/audio)
-- before that migration was ever meant to ship — but it reached this
-- project's remote database regardless (preview-branch auto-sync), so it
-- needs an explicit drop rather than just quietly not being recreated.

drop function if exists public.clone_public_deck(uuid, text);

-- ---------- imports pipeline tables ----------

drop policy if exists "imports_own" on public.imports;
create policy "imports_own" on public.imports
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "import_files_own" on public.import_files;
create policy "import_files_own" on public.import_files
  using (exists (select 1 from public.imports i where i.id = import_files.import_id and i.user_id = auth.uid()))
  with check (exists (select 1 from public.imports i where i.id = import_files.import_id and i.user_id = auth.uid()));

drop policy if exists "import_pages_own" on public.import_pages;
create policy "import_pages_own" on public.import_pages
  using (exists (select 1 from public.imports i where i.id = import_pages.import_id and i.user_id = auth.uid()))
  with check (exists (select 1 from public.imports i where i.id = import_pages.import_id and i.user_id = auth.uid()));

drop policy if exists "import_audio_files_own" on public.import_audio_files;
create policy "import_audio_files_own" on public.import_audio_files
  for all
  using (exists (select 1 from public.imports i where i.id = import_audio_files.import_id and i.user_id = auth.uid()))
  with check (exists (select 1 from public.imports i where i.id = import_audio_files.import_id and i.user_id = auth.uid()));

-- ---------- jobs (the import/extraction work queue) ----------
-- jobs_select was never admin-gated (owner-only already) — left untouched.

drop policy if exists "jobs_delete" on public.jobs;
create policy "jobs_delete" on public.jobs for delete using (user_id = auth.uid());

drop policy if exists "jobs_insert" on public.jobs;
create policy "jobs_insert" on public.jobs for insert with check (
  user_id = auth.uid()
  and (deck_id is null or exists (select 1 from public.decks d where d.id = jobs.deck_id and d.user_id = auth.uid()))
);

drop policy if exists "jobs_update" on public.jobs;
create policy "jobs_update" on public.jobs for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- storage: the four import-pipeline buckets ----------

drop policy if exists "import_sources_own" on storage.objects;
create policy "import_sources_own" on storage.objects
  for all
  using (
    bucket_id = 'import-sources'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  )
  with check (
    bucket_id = 'import-sources'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  );

drop policy if exists "import_audio_own" on storage.objects;
create policy "import_audio_own" on storage.objects
  for all
  using (
    bucket_id = 'import-audio'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  )
  with check (
    bucket_id = 'import-audio'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  );

drop policy if exists "import_page_renders_own" on storage.objects;
create policy "import_page_renders_own" on storage.objects
  for all
  using (
    bucket_id = 'import-page-renders'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  )
  with check (
    bucket_id = 'import-page-renders'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  );

drop policy if exists "import_page_pdfs_own" on storage.objects;
create policy "import_page_pdfs_own" on storage.objects
  for all
  using (
    bucket_id = 'import-page-pdfs'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  )
  with check (
    bucket_id = 'import-page-pdfs'
    and exists (select 1 from public.imports i where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid())
  );

-- ---------- stacks / cards: drop the admin requirement on the kind='page' / origin='textbook_extraction' branch ----------
-- The 'custom'/'manual' branch (owner-only, no admin gate) is unchanged.

drop policy if exists "stacks_select" on public.stacks;
create policy "stacks_select" on public.stacks for select using (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

drop policy if exists "stacks_insert" on public.stacks;
create policy "stacks_insert" on public.stacks for insert with check (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

drop policy if exists "stacks_update" on public.stacks;
create policy "stacks_update" on public.stacks for update using (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
) with check (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

drop policy if exists "stacks_delete" on public.stacks;
create policy "stacks_delete" on public.stacks for delete using (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

drop policy if exists "cards_select" on public.cards;
create policy "cards_select" on public.cards for select using (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

drop policy if exists "cards_insert" on public.cards;
create policy "cards_insert" on public.cards for insert with check (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

drop policy if exists "cards_update" on public.cards;
create policy "cards_update" on public.cards for update using (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
) with check (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

drop policy if exists "cards_delete" on public.cards;
create policy "cards_delete" on public.cards for delete using (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

-- ---------- approve_page_extraction: drop the inline is_admin() check ----------
-- SECURITY DEFINER already; ownership (i.user_id = auth.uid()) is the real
-- gate, is_admin() was an extra requirement stacked on top of it.

create or replace function public.approve_page_extraction(
  p_page_extraction_id uuid,
  p_force boolean default false,
  p_override_reason text default null
)
returns public.stacks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stacks;
  v_import_id uuid;
  v_all_approved boolean;
  v_has_warnings boolean;
begin
  select s.* into v_row
  from public.stacks s
  join public.import_pages ip on ip.id = s.source_page_id
  join public.imports i on i.id = ip.import_id
  where s.id = p_page_extraction_id and i.user_id = auth.uid()
  for update of s;

  if not found then
    raise exception 'page extraction not found, or you do not have permission to approve it';
  end if;

  v_has_warnings := jsonb_array_length(coalesce(v_row.unresolved_warnings, '[]'::jsonb)) > 0;

  if v_has_warnings and not p_force then
    raise exception 'cannot approve a page extraction with unresolved warnings without force=true';
  end if;

  if v_has_warnings and p_force and (p_override_reason is null or btrim(p_override_reason) = '') then
    raise exception 'a reason is required to approve a page with unresolved warnings';
  end if;

  update public.stacks
  set
    status = 'approved',
    reviewed_at = now(),
    reviewed_by = auth.uid(),
    updated_at = now(),
    approved_with_warnings = v_has_warnings,
    approval_override_reason = case when v_has_warnings then p_override_reason else null end
  where id = p_page_extraction_id
  returning * into v_row;

  select ip.import_id into v_import_id
  from public.import_pages ip
  where ip.id = v_row.source_page_id;

  -- "current extraction" per page = max version; approved only if every
  -- page's current extraction is itself approved.
  select not exists (
    select 1
    from public.import_pages ip
    join lateral (
      select s2.status
      from public.stacks s2
      where s2.source_page_id = ip.id
      order by s2.version desc
      limit 1
    ) current_s on true
    where ip.import_id = v_import_id and current_s.status <> 'approved'
  ) into v_all_approved;

  if v_all_approved then
    update public.imports set status = 'completed', updated_at = now() where id = v_import_id;
  end if;

  return v_row;
end;
$$;
