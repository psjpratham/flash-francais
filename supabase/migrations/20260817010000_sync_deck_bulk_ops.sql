-- syncDeckWorker.ts's reconcile pass was verified directly against real
-- production data (a 455-card deck's first sync) to take several minutes
-- even after batching writes to 15-way client concurrency — hundreds of
-- individual UPDATE round-trips from inside one Edge Function invocation
-- is fundamentally too slow, not something concurrency alone fixes.
-- sync_link_stacks/sync_link_cards do the exact same work in ONE round
-- trip each, via a single UPDATE against an unnested JSON pairs array.
--
-- Postgres grants EXECUTE to PUBLIC by default on function creation, which
-- would otherwise let any authenticated user link arbitrary stacks/cards
-- together (a real data-tampering vector, since these skip every RLS
-- ownership check other write paths have) — revoked immediately below,
-- callable only by the service-role sync worker.

create or replace function public.sync_link_stacks(pairs jsonb)
returns void
language sql
as $$
  update public.stacks s
  set cloned_from_stack_id = (p->>'orig_id')::uuid
  from jsonb_array_elements(pairs) as p
  where s.id = (p->>'clone_id')::uuid;
$$;

revoke all on function public.sync_link_stacks(jsonb) from public;
grant execute on function public.sync_link_stacks(jsonb) to service_role;

create or replace function public.sync_link_cards(pairs jsonb)
returns void
language sql
as $$
  update public.cards c
  set cloned_from_card_id = (p->>'orig_id')::uuid
  from jsonb_array_elements(pairs) as p
  where c.id = (p->>'clone_id')::uuid;
$$;

revoke all on function public.sync_link_cards(jsonb) from public;
grant execute on function public.sync_link_cards(jsonb) to service_role;

-- `imports` had no index beyond its primary key — syncDeckWorker.ts looks
-- up imports by merged_stack_id (for custom/merged stacks, which have no
-- page of their own to key off) and by deck_id, both previously full
-- table scans.
create index if not exists imports_merged_stack_idx on public.imports (merged_stack_id) where merged_stack_id is not null;
create index if not exists imports_deck_idx on public.imports (deck_id);
