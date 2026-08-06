-- "Sync with original deck" — lets a clone owner pull in whatever's new on
-- the deck they cloned from (new stacks, new cards within existing stacks,
-- even whole new imports) without ever touching FSRS state or anything the
-- clone owner already has, and without ever deleting anything.
--
-- clone-public-deck (supabase/functions/clone-public-deck/index.ts) gives
-- every cloned row a brand-new uuid with NO link back to what it was copied
-- from — decks.cloned_from_deck_id is the only surviving relationship, and
-- it's deck-level only. Below that, sync has no way to tell "this card
-- already exists over there" from "this card is genuinely new" without a
-- row-level link. cloned_from_stack_id/cloned_from_card_id are that link —
-- set going forward at clone/sync time, and backfilled by syncDeckWorker.ts's
-- one-time reconciliation pass the first time an already-existing clone is
-- synced (matched by page position + content, not by a separate migration
-- script).
--
-- deck_syncs is a pure history log (date + counts), written only by the
-- service-role sync worker — never by client code — same posture as `jobs`.
-- added_by_sync_id on stacks/cards is set ONLY on rows a sync genuinely
-- added, never on rows the reconciliation pass merely linked — that
-- distinction is what makes "what did sync X actually add" answerable later
-- without guessing from timestamps (which the reextract/generate-cards
-- features already showed can't be trusted, since other actions create rows
-- around the same time).

create table if not exists public.deck_syncs (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.decks(id) on delete cascade,
  synced_at timestamptz not null default now(),
  status text not null check (status in ('completed', 'failed')),
  error text,
  stacks_added integer not null default 0,
  cards_added integer not null default 0,
  imports_added integer not null default 0
);

create index if not exists deck_syncs_deck_idx on public.deck_syncs (deck_id, synced_at desc);

alter table public.deck_syncs enable row level security;

-- Read-only for the deck owner; no insert/update/delete policy at all —
-- only the service-role worker ever writes here, same as `jobs`' own
-- complete_job/fail_job-only write path.
create policy "deck_syncs_select" on public.deck_syncs for select using (
  exists (select 1 from public.decks d where d.id = deck_syncs.deck_id and d.user_id = auth.uid())
);

alter table public.stacks
  add column if not exists cloned_from_stack_id uuid references public.stacks(id) on delete set null,
  add column if not exists added_by_sync_id uuid references public.deck_syncs(id) on delete set null;

alter table public.cards
  add column if not exists cloned_from_card_id uuid references public.cards(id) on delete set null,
  add column if not exists added_by_sync_id uuid references public.deck_syncs(id) on delete set null;

-- A given deck should never link twice to the same original row — guards
-- against a concurrent/retried sync double-linking (and therefore
-- double-adding) the same original stack/card.
create unique index if not exists stacks_deck_cloned_from_unique on public.stacks (deck_id, cloned_from_stack_id) where cloned_from_stack_id is not null;
create unique index if not exists cards_deck_cloned_from_unique on public.cards (deck_id, cloned_from_card_id) where cloned_from_card_id is not null;
