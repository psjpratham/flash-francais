-- get_deck_tags previously only counted cards with include_in_practice =
-- true — fine back when it only fed Practice mode's own tag filter, but it
-- now exclusively backs Study mode's tag filter (studyPicker.ts), which
-- must cover every card in a stack regardless of practice inclusion (a
-- freshly-extracted, not-yet-included-in-practice stack should still be
-- studyable and filterable by tag). Drop the include_in_practice filter so
-- the tag pool and its counts reflect every card in the deck.
create or replace function public.get_deck_tags(p_deck_id uuid) returns jsonb
    language sql
    as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('tag', tag, 'count', cnt) order by cnt desc, tag asc),
    '[]'::jsonb
  )
  from (
    select t as tag, count(*) as cnt
    from public.cards c, unnest(c.tags) as t
    where c.deck_id = p_deck_id
      and exists (select 1 from public.decks d where d.id = c.deck_id and d.user_id = auth.uid())
    group by t
  ) x;
$$;
