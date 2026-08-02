-- ensureDefaultDecksCloned's "do I already have a clone of this default
-- deck?" check races against itself whenever it's triggered twice close
-- together (e.g. a page refresh landing while the first clone, which
-- copies real files over the network and can take several seconds, is
-- still in flight) — both calls see zero existing clones and both proceed,
-- producing two independent copies of the same default deck for one user.
--
-- A unique constraint makes the second concurrent insert fail atomically at
-- the database instead of silently succeeding twice; clone-public-deck
-- catches that specific failure and returns the winning row instead of
-- erroring, so from the caller's side concurrent clone attempts safely
-- converge on one deck. NULL cloned_from_deck_id (an originally-authored
-- deck) is exempt — Postgres never treats two NULLs as duplicates, so this
-- doesn't limit how many of your own decks you can create.
--
-- First, collapse any duplicates ensureDefaultDecksCloned already created
-- under the old race-prone version — keep the earliest clone per
-- (user_id, cloned_from_deck_id), delete the rest. ON DELETE CASCADE on
-- cards/stacks/imports etc. (see 20260724220036_remote_schema.sql) means
-- deleting the duplicate deck row is enough; nothing under it needs
-- separate cleanup.
delete from public.decks d
using public.decks keep_d
where d.cloned_from_deck_id is not null
  and keep_d.cloned_from_deck_id = d.cloned_from_deck_id
  and keep_d.user_id = d.user_id
  and keep_d.id <> d.id
  and (keep_d.created_at, keep_d.id) < (d.created_at, d.id);

alter table public.decks
  add constraint decks_user_cloned_from_unique unique (user_id, cloned_from_deck_id);
