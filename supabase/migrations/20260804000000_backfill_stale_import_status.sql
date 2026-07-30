-- One-time backfill: maybeFinalizeImport (extractWorker.ts) used to compute
-- imports.status by checking whether ANY extract_page job for the import
-- had ever failed, without deduping by page — so an import whose only
-- failed page was later successfully retried (a brand-new job row, the old
-- failed one kept as history) stayed pinned at 'completed_with_errors'
-- forever. That read path is now fixed (dedupes to each page's latest job),
-- but already-stuck imports.status values were written before the fix and
-- won't self-heal without a new job event. Recompute them here the same way
-- the fixed code does: only each page's most recent job counts.
with latest_jobs as (
  select distinct on (payload->>'import_id', payload->>'page_id')
    payload->>'import_id' as import_id,
    status,
    created_at
  from public.jobs
  where type = 'extract_page'
  order by payload->>'import_id', payload->>'page_id', created_at desc
),
import_agg as (
  select import_id,
    bool_or(status = 'failed') as any_failed,
    bool_or(status = 'completed') as any_completed,
    bool_or(status in ('queued', 'processing')) as any_active
  from latest_jobs
  group by import_id
)
update public.imports i
set status = case
    when not a.any_completed then 'failed'
    when a.any_failed then 'completed_with_errors'
    else 'needs_review'
  end,
  updated_at = now(),
  last_progress_at = now()
from import_agg a
where a.import_id = i.id::text
  and not a.any_active
  -- Never touch an import a reviewer already fully approved, or one still
  -- mid-extraction — same guard maybeFinalizeImport itself uses.
  and i.status <> 'completed';
