-- One-time operational fix: an earlier version of dispatch-import-work
-- auto-requeued stale extract_page jobs (removed — see extractWorker.ts,
-- retries are manual-only now), which turned one YouTube-transcript page
-- that kept hitting its extraction budget into a job that silently
-- reattempted forever with no error ever recorded (nothing in this
-- codebase's history called fail_job on a plain uncaught exception either
-- — also fixed, same commit). Whatever invocation is still live for these
-- rows will find status != 'processing' on its own eventual
-- complete_job/fail_job call and simply no-op (both RPCs already guard
-- `and status = 'processing'`) — this does not kill a running Edge
-- Function invocation, it just stops the row from ever being reclaimed
-- again.
update public.jobs
set status = 'failed',
    error = 'manually stopped — was stuck reattempting under an auto-retry bug that has since been removed; re-run manually via Retry failed extraction',
    completed_at = now()
where type = 'extract_page' and status = 'processing';
