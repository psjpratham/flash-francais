-- Shared/default decks (visibility='shared') were being live-referenced
-- straight out of listDecks() (user_id=me OR visibility='shared') rather
-- than actually cloned into each user's own library — so every non-owner
-- could open one and swipe cards in Practice mode, but every single grade
-- silently failed to save: cards_update has no branch granting write access
-- for a shared deck's cards to anyone but the original owner/importer (by
-- design — see 20260814000000_shared_deck_read_access.sql's own comment,
-- "INSERT/UPDATE/DELETE are untouched"). The fix is for every user to get a
-- REAL, fully-owned clone of each default deck (via the existing
-- clone-public-deck edge function, which already does this correctly for
-- is_public decks) instead of ever touching the original's rows.
--
-- cloned_from_deck_id lets the client reliably answer "have I already
-- cloned this specific default deck?" (matching by name would be fragile —
-- nothing stops two decks sharing a name) so the client-side check that
-- ensures every user has a copy of every current default deck can run
-- idempotently on every app load, self-healing accounts that predate this
-- migration without a separate one-off backfill script.
alter table public.decks
  add column if not exists cloned_from_deck_id uuid references public.decks(id) on delete set null;

comment on column public.decks.cloned_from_deck_id is
  'Set by clone-public-deck when this deck was created as a copy of another (a public deck via "Add to my decks", or a shared/default deck auto-cloned on login). Null for an originally-authored deck.';
