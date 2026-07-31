-- Lets a deck owner mark their personal deck "public" (searchable by every
-- other authenticated user, by title/author/id) — distinct from the existing
-- admin-curated visibility='shared' system. A profile's display_name is only
-- ever exposed to other users when it's the author of at least one public
-- deck; there is still no general "browse anyone's profile" surface.

alter table public.decks
  add column if not exists is_public boolean not null default false;

alter table public.profiles
  add column if not exists display_name text;

comment on column public.decks.is_public is 'Owner-controlled: when true (and status=published), the deck is readable by every authenticated user and shows up in deck search.';
comment on column public.profiles.display_name is 'User-chosen name shown as deck author on a public deck. Null until the user sets one.';

-- decks_select: add the is_public branch alongside the existing owner / admin-shared branches.
drop policy if exists "decks_select" on public.decks;
create policy "decks_select" on public.decks for select using (
  ("user_id" = "auth"."uid"())
  or (("visibility" = 'shared'::"text") and ("status" = 'published'::"text"))
  or (("is_public" = true) and ("status" = 'published'::"text"))
);

-- A profile becomes readable by other authenticated users only through
-- having a public deck — never a general "list all users" surface.
create policy "profiles_select_public_authors" on public.profiles for select using (
  exists (
    select 1 from public.decks d
    where d.user_id = profiles.id and d.is_public = true and d.status = 'published'
  )
);

-- Speeds up the public-deck search below; small table today, but cheap to have.
create index if not exists decks_is_public_idx on public.decks (is_public) where is_public;

-- No general profiles UPDATE policy exists (deliberately — it would let a
-- user rewrite their own `role` to 'admin'). This RPC is the only way for a
-- user to change their display_name: SECURITY DEFINER, but scoped to
-- exactly one column of exactly the caller's own row.
create or replace function public.set_my_display_name(p_display_name text) returns public.profiles
    language plpgsql
    security definer
    set search_path = public
    as $$
declare
  v_name text := nullif(trim(p_display_name), '');
  v_row public.profiles;
begin
  if v_name is not null and length(v_name) > 60 then
    raise exception 'Display name must be 60 characters or fewer';
  end if;
  update public.profiles set display_name = v_name where id = auth.uid()
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Profile not found';
  end if;
  return v_row;
end;
$$;

grant execute on function public.set_my_display_name(text) to authenticated;

-- Search across every public, published deck by title, author display name,
-- or id (prefix match — the UI shows/accepts the id's first 8 characters).
-- Plain SQL/invoker rights: relies on decks_select + profiles_select_public_authors
-- above, so it can never return anything those policies wouldn't already allow.
create or replace function public.search_public_decks(p_query text default null) returns table (
    id uuid,
    name text,
    created_at timestamptz,
    user_id uuid,
    author_display_name text,
    card_count bigint
) language sql stable as $$
  select
    d.id,
    d.name,
    d.created_at,
    d.user_id,
    p.display_name as author_display_name,
    (select count(*) from public.cards c where c.deck_id = d.id) as card_count
  from public.decks d
  left join public.profiles p on p.id = d.user_id
  where d.is_public = true
    and d.status = 'published'
    and (
      p_query is null or btrim(p_query) = ''
      or d.name ilike '%' || p_query || '%'
      or coalesce(p.display_name, '') ilike '%' || p_query || '%'
      or d.id::text ilike p_query || '%'
    )
  order by d.created_at desc
  limit 50;
$$;

grant execute on function public.search_public_decks(text) to authenticated;
