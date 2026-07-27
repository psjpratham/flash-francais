-- Durable import pipeline, step 1: imports becomes the single source of
-- truth for coarse status + real page-by-page preprocessing progress.
--
-- These columns are written ONLY by the trusted server-side worker (a
-- service-role client, which bypasses RLS entirely — standard Supabase
-- behaviour, no policy changes needed for that). The browser never writes
-- them; it only ever reads. This replaces the old design where the browser
-- inferred progress by re-deriving it from job rows on every poll, which is
-- exactly what produced an import stuck forever at "Reading pages" once the
-- browser that owned the pipeline navigated away.

alter table public.imports
  add column if not exists status text not null default 'uploaded'
    check (status in ('uploaded', 'preprocessing', 'extracting', 'needs_review', 'completed', 'completed_with_errors', 'failed')),
  add column if not exists total_pages integer,
  add column if not exists pages_discovered integer not null default 0,
  add column if not exists pages_prepared integer not null default 0,
  add column if not exists pages_failed_preprocessing integer not null default 0,
  add column if not exists current_page_index integer,
  add column if not exists preprocessing_error text,
  add column if not exists last_progress_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Existing imports (created before this column existed) already have real
-- persisted page/job state — backfill status from it once, so they don't
-- all start misleadingly at 'uploaded'.
update public.imports i
set status = case
  when exists (
    select 1 from public.page_extractions pe
    join public.import_pages ip on ip.id = pe.page_id
    where ip.import_id = i.id and pe.status = 'needs_review'
  ) then 'needs_review'
  when exists (
    select 1 from public.import_pages ip where ip.import_id = i.id
  ) then 'extracting'
  else 'uploaded'
end,
total_pages = (select count(*) from public.import_pages ip where ip.import_id = i.id),
pages_discovered = (select count(*) from public.import_pages ip where ip.import_id = i.id),
pages_prepared = (select count(*) from public.import_pages ip where ip.import_id = i.id and ip.extraction_status = 'extracted'),
pages_failed_preprocessing = (select count(*) from public.import_pages ip where ip.import_id = i.id and ip.extraction_status = 'unreadable'),
last_progress_at = i.created_at
where exists (select 1 from public.import_pages ip where ip.import_id = i.id);

-- ---------- service-role bypass for the job-claim RPCs ----------
-- claim_jobs/complete_job/fail_job filter `user_id = auth.uid()` in their
-- SQL bodies (not just via RLS), so a service-role-authenticated caller —
-- auth.uid() is null for it, since there's no user JWT — could never claim
-- or resolve ANY job. The durable dispatcher runs as service_role (it must
-- process every admin's queued work, not one specific user's), so these
-- three functions need an explicit service_role bypass alongside the
-- existing owner check.

create or replace function public.claim_jobs(p_type text, p_limit integer default 5)
returns setof public.jobs
language sql
security definer
set search_path = public
as $$
  update public.jobs
  set status = 'processing', started_at = now(), attempt_count = attempt_count + 1
  where id in (
    select id from public.jobs
    where type = p_type and status = 'queued' and (user_id = auth.uid() or auth.role() = 'service_role')
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning *;
$$;

create or replace function public.complete_job(p_job_id uuid, p_result jsonb default '{}'::jsonb)
returns public.jobs
language sql
security definer
set search_path = public
as $$
  update public.jobs
  set status = 'completed', result = p_result, completed_at = now()
  where id = p_job_id and (user_id = auth.uid() or auth.role() = 'service_role') and status = 'processing'
  returning *;
$$;

create or replace function public.fail_job(p_job_id uuid, p_error text)
returns public.jobs
language sql
security definer
set search_path = public
as $$
  update public.jobs
  set status = 'failed', error = p_error, completed_at = now()
  where id = p_job_id and (user_id = auth.uid() or auth.role() = 'service_role') and status = 'processing'
  returning *;
$$;
