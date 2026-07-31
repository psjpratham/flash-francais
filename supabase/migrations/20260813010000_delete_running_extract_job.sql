-- User-requested: delete the one currently-'processing' extract_page job
-- (id 57b42e81-a131-4535-9501-d8f10829bee1) outright rather than just
-- marking it failed. Does not stop a live Edge Function invocation still
-- executing this job (that isn't possible via SQL) — but removes the row
-- so no future dispatch tick or admin retry can ever act on it again, and
-- its eventual complete_job/fail_job RPC call (both guard `and status =
-- 'processing'`) will simply find no matching row and no-op.
delete from public.jobs
where id = '57b42e81-a131-4535-9501-d8f10829bee1' and type = 'extract_page' and status = 'processing';
