-- Durable import pipeline, step 2: a server-side dispatcher that keeps
-- processing queued import work independently of any browser tab.
--
-- pg_cron ticks on a fixed schedule and calls the "dispatch-import-work"
-- Edge Function via pg_net (async HTTP from Postgres) — that function claims
-- and processes a small bounded batch of preprocess_import/extract_page jobs
-- and exits. This is the actual fix for imports getting stuck forever once
-- the browser that started them navigates away: nothing about progress now
-- depends on a browser being open at all.
--
-- Auth: the dispatcher sends a random shared secret (stored in Supabase
-- Vault by name, never in this file) as an `x-cron-secret` header; the Edge
-- Function checks it and, if valid, builds its own service-role client from
-- its auto-injected SUPABASE_SERVICE_ROLE_KEY env var — the powerful key
-- itself never has to pass through cron/pg_net.
--
-- One-time manual step after this migration is applied (never committed):
--   select vault.create_secret('<random-value>', 'cron_dispatch_secret');
--   supabase secrets set CRON_DISPATCH_SECRET=<same random-value>
-- Until that secret exists, dispatch_import_work() below is a safe no-op
-- (it checks for the secret and returns immediately if absent) — so this
-- migration is 100% safe to apply before that step is done.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Not exposed via PostgREST (only schemas listed in config.toml's
-- [api].schemas are), so this is a safe place for internal-only plumbing.
create schema if not exists private;

create or replace function private.dispatch_import_work()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_secret text;
  v_project_url text := 'https://jtqyshehnmlnlvlxzzpf.supabase.co';
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_dispatch_secret' limit 1;
  if v_secret is null then
    return; -- not configured yet — safe no-op, never errors the cron job
  end if;

  perform net.http_post(
    url := v_project_url || '/functions/v1/dispatch-import-work',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb
  );
end;
$$;

-- cron.schedule upserts by job name, so re-running this migration never
-- creates a duplicate schedule. Sub-minute interval syntax (pg_cron >=1.4,
-- confirmed available here at 1.6.4) — falls back to verifying against
-- cron.job after deploy; if unsupported, change to '* * * * *' (every
-- minute) instead.
select cron.schedule('dispatch-import-work', '30 seconds', $$ select private.dispatch_import_work(); $$);
