-- decks_select already lets every user see the ROW for a visibility='shared'
-- + status='published' deck (the admin-curated "default deck" system), but
-- stacks_select/cards_select never got the matching carve-out — they only
-- ever checked deck ownership (or, for textbook_extraction cards, the
-- importing user). Result: a shared deck shows up in every user's Library
-- but its content is invisible to everyone except the original owner —
-- "empty deck" from any other user's point of view.
--
-- Fix: add a read-only "the deck is shared and published" branch to both
-- policies, on top of the existing ownership branches. INSERT/UPDATE/DELETE
-- are untouched — only the owner (or, for textbook_extraction, the
-- importer) can still edit a shared deck's stacks/cards.

drop policy if exists "stacks_select" on public.stacks;
create policy "stacks_select" on public.stacks for select using (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
  or
  exists (select 1 from public.decks d where d.id = stacks.deck_id and d.visibility = 'shared' and d.status = 'published')
);

drop policy if exists "cards_select" on public.cards;
create policy "cards_select" on public.cards for select using (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
  or
  exists (select 1 from public.decks d where d.id = cards.deck_id and d.visibility = 'shared' and d.status = 'published')
);
