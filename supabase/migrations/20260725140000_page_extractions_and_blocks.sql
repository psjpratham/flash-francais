-- Page-first refactor, step 2: versioned extractions + ordered blocks.
--
-- One import_page can be (re-)extracted multiple times — each attempt is a
-- new page_extractions row (version = 1, 2, 3...), never an in-place
-- mutation of a prior one. Retrying/re-extracting a page therefore can never
-- duplicate or corrupt another version's blocks: page_blocks belongs to
-- exactly one page_extractions row, and the review UI always reads the
-- max-version row per page. Old versions are kept for audit history
-- (repair_history/diagnostics), never deleted.
--
-- page_id is denormalized onto page_blocks (not just reachable via
-- page_extraction_id) because "every future card must be able to link to
-- page_id and page_block_id" (per the product spec) — a card generator
-- should never need to join through page_extractions to find which page a
-- block came from.

create table if not exists public.page_extractions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.import_pages(id) on delete cascade,
  version integer not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'needs_review', 'approved', 'failed')),
  model text,
  prompt_version text,
  raw_model_response jsonb,
  model_warnings jsonb not null default '[]',
  coverage_result jsonb,
  audit_result jsonb,
  repair_history jsonb not null default '[]',
  unresolved_warnings jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  unique (page_id, version)
);

create index if not exists page_extractions_page_idx on public.page_extractions (page_id, version desc);

create table if not exists public.page_blocks (
  id uuid primary key default gen_random_uuid(),
  page_extraction_id uuid not null references public.page_extractions(id) on delete cascade,
  page_id uuid not null references public.import_pages(id) on delete cascade,
  order_index integer not null,
  kind text not null check (kind in ('document', 'interaction', 'image_ref', 'audio_ref')),
  component_type text not null,
  source_line_ids text[] not null default '{}',
  source_text text not null default '',
  content jsonb not null default '{}',
  needs_review boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists page_blocks_extraction_idx on public.page_blocks (page_extraction_id, order_index);
create index if not exists page_blocks_page_idx on public.page_blocks (page_id);

alter table public.page_extractions enable row level security;
alter table public.page_blocks enable row level security;

-- Same "deck owner or admin" shape as import_pages_own, reached through
-- page_id -> import_pages -> imports -> decks (or page_extraction_id for
-- page_blocks, one hop further).

create policy "page_extractions_own" on public.page_extractions
  for all
  using (
    exists (
      select 1 from public.import_pages ip
      join public.imports i on i.id = ip.import_id
      where ip.id = page_extractions.page_id and i.user_id = auth.uid() and public.is_admin()
    )
  )
  with check (
    exists (
      select 1 from public.import_pages ip
      join public.imports i on i.id = ip.import_id
      where ip.id = page_extractions.page_id and i.user_id = auth.uid() and public.is_admin()
    )
  );

create policy "page_blocks_own" on public.page_blocks
  for all
  using (
    exists (
      select 1 from public.import_pages ip
      join public.imports i on i.id = ip.import_id
      where ip.id = page_blocks.page_id and i.user_id = auth.uid() and public.is_admin()
    )
  )
  with check (
    exists (
      select 1 from public.import_pages ip
      join public.imports i on i.id = ip.import_id
      where ip.id = page_blocks.page_id and i.user_id = auth.uid() and public.is_admin()
    )
  );

-- A page cannot become 'approved' while unresolved_warnings is non-empty —
-- a plain RLS UPDATE policy can't express a condition against a jsonb
-- array's length, so approval is funnelled through this RPC (same
-- claim_jobs/complete_job/fail_job SECURITY DEFINER pattern already used for
-- jobs), which re-checks ownership itself since it runs as the table owner.
--
-- Once every page in the import has its current (max-version) extraction
-- approved, the import itself flips to 'completed' — the only place that
-- status is ever set, since it's meant to mean "review is genuinely done",
-- not just "extraction finished" (that's 'needs_review').
create or replace function public.approve_page_extraction(p_page_extraction_id uuid)
returns public.page_extractions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.page_extractions;
  v_import_id uuid;
  v_all_approved boolean;
begin
  select pe.* into v_row
  from public.page_extractions pe
  join public.import_pages ip on ip.id = pe.page_id
  join public.imports i on i.id = ip.import_id
  where pe.id = p_page_extraction_id and i.user_id = auth.uid() and public.is_admin()
  for update of pe;

  if not found then
    raise exception 'page extraction not found, or you do not have permission to approve it';
  end if;

  select ip.import_id into v_import_id
  from public.import_pages ip
  where ip.id = v_row.page_id;

  if jsonb_array_length(coalesce(v_row.unresolved_warnings, '[]'::jsonb)) > 0 then
    raise exception 'cannot approve a page extraction with unresolved warnings';
  end if;

  update public.page_extractions
  set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), updated_at = now()
  where id = p_page_extraction_id
  returning * into v_row;

  -- "current extraction" per page = max version; approved only if every
  -- page's current extraction is itself approved.
  select not exists (
    select 1
    from public.import_pages ip
    join lateral (
      select pe2.status
      from public.page_extractions pe2
      where pe2.page_id = ip.id
      order by pe2.version desc
      limit 1
    ) current_pe on true
    where ip.import_id = v_import_id and current_pe.status <> 'approved'
  ) into v_all_approved;

  if v_all_approved then
    update public.imports set status = 'completed', updated_at = now() where id = v_import_id;
  end if;

  return v_row;
end;
$$;

grant execute on function public.approve_page_extraction(uuid) to authenticated;
