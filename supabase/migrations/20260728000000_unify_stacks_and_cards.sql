-- ============================================================================
-- Phase 1 of the Deck > Stack > Card redesign: unify the import pipeline
-- (page_extractions/page_blocks) and the FSRS practice system (notes/cards)
-- into stacks/cards. Zero user-visible behavior change — this is a schema
-- consolidation only, so that a card can be edited and toggled in/out of
-- practice in place, instead of living as two separate rows (a reviewable
-- page_block and a copied-out practice note+card) that can drift apart.
--
-- Ordering is load-bearing:
--   1. old cards -> cards_legacy_fsrs (clears the name for step 3)
--   2. page_extractions -> stacks (+ new columns, +backfill)
--   3. page_blocks -> cards (+ new columns, +backfill)
--   4. fold in notes' manual (never-sent) rows as a synthetic per-deck stack
--   5. fold in notes' bridged (sent-to-practice) rows by UPDATE, not INSERT
--   6. remap review_log.card_id for the bridged rows + repoint its FK
--   7. rewrite get_stats/get_deck_tags/approve_page_extraction (all three
--      hard-reference the old table/column names in their SQL bodies)
--   8. RLS on stacks/cards
--   9. rename notes / cards_legacy_fsrs to inert backups (NOT dropped)
-- ============================================================================

-- ---------- 1. old cards out of the way ----------

alter table public.cards rename to cards_legacy_fsrs;
-- Constraints/indexes/policies (cards_pkey, cards_deck_id_fkey,
-- cards_note_id_fkey, cards_user_id_fkey, cards_own, ...) follow the rename
-- automatically, renamed but functionally untouched. The inbound FK from
-- review_log_card_id_fkey now points at cards_legacy_fsrs — step 6 repoints
-- it at the new cards table once the case-B remap is done.

-- ---------- 2. page_extractions -> stacks ----------

alter table public.page_extractions rename to stacks;

alter table public.stacks rename column page_id to source_page_id;
alter table public.stacks alter column source_page_id drop not null;
-- FK (renamed from page_extractions_page_id_fkey) keeps pointing at
-- import_pages(id) automatically; the unique(page_id, version) constraint
-- becomes unique(source_page_id, version) automatically too — multiple NULL
-- source_page_id rows (our synthetic 'custom' stacks) are unaffected since
-- SQL unique constraints never treat two NULLs as conflicting.

alter table public.stacks
  add column if not exists deck_id uuid references public.decks(id) on delete cascade,
  add column if not exists name text,
  add column if not exists kind text not null default 'page' check (kind in ('page', 'custom'));

update public.stacks s
set deck_id = i.deck_id,
    name = 'Page ' || coalesce(ip.displayed_page_number::text, (ip.page_index + 1)::text)
from public.import_pages ip
join public.imports i on i.id = ip.import_id
where ip.id = s.source_page_id;

-- Every existing row is kind='page' with a source_page_id, so the update
-- above must have populated every one of them.
alter table public.stacks alter column deck_id set not null;
alter table public.stacks alter column name set not null;

alter table public.stacks
  add constraint stacks_kind_source_page_consistency check (
    (kind = 'page' and source_page_id is not null) or
    (kind = 'custom' and source_page_id is null)
  );

create index if not exists stacks_deck_idx on public.stacks (deck_id);
alter index if exists page_extractions_page_idx rename to stacks_source_page_idx;

-- ---------- 3. page_blocks -> cards ----------

alter table public.page_blocks rename to cards;

alter table public.cards rename column page_extraction_id to stack_id;
-- FK (renamed from cards_page_extraction_id_fkey) now points at stacks(id).

alter table public.cards rename column page_id to source_page_id;
alter table public.cards alter column source_page_id drop not null;
-- FK -> import_pages(id) preserved through the rename.

alter table public.cards rename column kind to block_kind;
alter table public.cards alter column block_kind drop not null;
alter table public.cards rename constraint page_blocks_kind_check to cards_block_kind_check;

alter table public.cards alter column component_type drop not null;
alter table public.cards alter column source_line_ids drop not null;
alter table public.cards alter column source_text drop not null;
alter table public.cards alter column content drop not null;
alter table public.cards alter column answer_key_status drop not null;
alter table public.cards alter column pronunciation_enabled drop not null;
alter table public.cards alter column needs_review drop not null;
-- tags stays NOT NULL default '{}' — a genuinely shared column: both
-- notes.tags and page_blocks.tags were already text[] '{}' independently.

alter table public.cards
  add column if not exists deck_id uuid references public.decks(id) on delete cascade,
  add column if not exists origin text not null default 'textbook_extraction' check (origin in ('manual', 'textbook_extraction'));

update public.cards c
set deck_id = i.deck_id
from public.import_pages ip
join public.imports i on i.id = ip.import_id
where ip.id = c.source_page_id;

alter table public.cards alter column deck_id set not null;

alter table public.cards
  add constraint cards_origin_source_page_consistency check (
    (origin = 'textbook_extraction' and source_page_id is not null and block_kind is not null) or
    (origin = 'manual' and source_page_id is null)
  );

-- ---- notes' remaining fields, as new nullable columns (origin='manual') ----
alter table public.cards
  add column if not exists note_type text,
  add column if not exists fields jsonb,
  add column if not exists review_status text check (review_status in ('approved', 'needs_review')),
  add column if not exists confidence text check (confidence in ('high', 'medium', 'low')),
  add column if not exists review_reasons text[],
  add column if not exists source_evidence jsonb,
  add column if not exists extraction_diagnostics jsonb;

-- ---- old cards' FSRS fields, as new columns, populated for EVERY row ----
alter table public.cards
  add column if not exists state text not null default 'new',
  add column if not exists due timestamptz not null default now(),
  add column if not exists difficulty double precision,
  add column if not exists stability double precision,
  add column if not exists reps integer not null default 0,
  add column if not exists lapses integer not null default 0,
  add column if not exists step integer not null default 0,
  add column if not exists last_review timestamptz;
-- Defaults match exactly what a brand-new 'new' card looks like today (see
-- src/lib/cards.ts's bulkInsertNotesAndCards): state:'new', due:now(),
-- difficulty/stability left null (src/lib/fsrs.ts's scheduleCard never
-- reads card.difficulty/card.stability while card.state === 'new', so null
-- is exactly the pre-existing shape, not a new default being invented
-- here), reps/lapses/step: 0. Every pre-existing (formerly page_blocks) row
-- therefore ends up looking exactly like a never-studied fresh card, which
-- is correct — none of them had FSRS state of their own before this.

alter table public.cards
  add column if not exists include_in_practice boolean not null default true;

-- Every row that came from page_blocks was, by definition, not already in
-- the practice queue under the old schema (only a bridged notes row would
-- have been) — flip the default back off for all of them; the case-B
-- backfill below turns the previously-sent subset back on.
update public.cards set include_in_practice = false where origin = 'textbook_extraction';

create index if not exists cards_deck_idx on public.cards (deck_id, include_in_practice);
create index if not exists cards_due_idx2 on public.cards (deck_id, state, due) where include_in_practice;
alter index if exists page_blocks_extraction_idx rename to cards_stack_idx;
alter index if exists page_blocks_page_idx rename to cards_source_page_idx;

-- ---------- 4. Case A: pure-manual notes (source_block_id IS NULL) ----------
-- One synthetic 'custom' stack per deck that has any such notes, then one
-- cards row per (note, its cards_legacy_fsrs row), preserving the OLD
-- cards_legacy_fsrs.id as the new row's id verbatim so review_log.card_id
-- keeps resolving with zero remapping for this branch.

insert into public.stacks (id, deck_id, name, kind, source_page_id, version, status)
select gen_random_uuid(), d.id, 'Manual cards', 'custom', null, 1, 'approved'
from public.decks d
where exists (
  select 1 from public.notes n
  where n.deck_id = d.id and n.source_block_id is null
);

insert into public.cards (
  id, stack_id, deck_id, order_index, origin,
  tags, note_type, fields, review_status, confidence, review_reasons,
  source_evidence, extraction_diagnostics,
  state, due, difficulty, stability, reps, lapses, step, last_review,
  include_in_practice, created_at
)
select
  ocl.id,                                   -- preserve legacy card id verbatim
  s.id,
  n.deck_id,
  row_number() over (partition by n.deck_id order by n.created_at) - 1,
  'manual',
  n.tags, n.note_type, n.fields, n.review_status, n.confidence, n.review_reasons,
  n.source_evidence, n.extraction_diagnostics,
  ocl.state, ocl.due, ocl.difficulty, ocl.stability, ocl.reps, ocl.lapses, ocl.step, ocl.last_review,
  true, ocl.created_at
from public.notes n
join public.cards_legacy_fsrs ocl on ocl.note_id = n.id
join public.stacks s on s.deck_id = n.deck_id and s.kind = 'custom'
where n.source_block_id is null;

-- ---------- 5. Case B: bridged notes (source_block_id IS NOT NULL) ----------
-- id is already correct (it's the page_block id, unchanged through the
-- page_blocks -> cards rename) — UPDATE the already-migrated row in place,
-- copying over FSRS state from the matching legacy cards row, rather than
-- inserting a new one.

update public.cards c
set
  state = ocl.state,
  due = ocl.due,
  difficulty = ocl.difficulty,
  stability = ocl.stability,
  reps = ocl.reps,
  lapses = ocl.lapses,
  step = ocl.step,
  last_review = ocl.last_review,
  include_in_practice = true
from public.notes n
join public.cards_legacy_fsrs ocl on ocl.note_id = n.id
where n.source_block_id is not null
  and c.id = n.source_block_id;

-- ---------- 6. remap review_log for the case-B rows ----------
-- The FK must be dropped BEFORE this remap, not after: it was created
-- against "cards" before step 1's rename, so it still targets
-- cards_legacy_fsrs (renaming a table never repoints an *inbound* FK to
-- whatever later takes over its old name) — an UPDATE setting card_id to a
-- page_block-derived id (which only exists in the NEW cards table) would
-- otherwise be rejected by a constraint still checking against the OLD one.

alter table public.review_log drop constraint review_log_card_id_fkey;

update public.review_log rl
set card_id = n.source_block_id
from public.notes n
join public.cards_legacy_fsrs ocl on ocl.note_id = n.id
where n.source_block_id is not null
  and rl.card_id = ocl.id;

-- Case-A rows never needed remapping: review_log.card_id already equals
-- cards_legacy_fsrs.id, which is exactly the id preserved verbatim onto the
-- new cards row in step 4.

do $$
declare v_orphans integer;
begin
  select count(*) into v_orphans
  from public.review_log rl
  where not exists (select 1 from public.cards c where c.id = rl.card_id);
  if v_orphans > 0 then
    raise exception 'unify_stacks_and_cards: % review_log rows have no matching cards row after migration', v_orphans;
  end if;
end $$;

alter table public.review_log
  add constraint review_log_card_id_fkey foreign key (card_id) references public.cards(id) on delete cascade;

-- ---------- 7. rewrite get_stats / get_deck_tags / approve_page_extraction ----------
-- All three hard-reference tables/columns being renamed or retired. Without
-- this, deck stats, the tag filter dropdown, and page approval all break.

create or replace function public.get_stats(p_deck_id uuid default null::uuid) returns jsonb
    language plpgsql
    as $$
declare
  result jsonb;
  now_ts timestamptz := now();
begin
  select jsonb_build_object(
    'cards', jsonb_build_object(
      'total', count(*),
      'new', count(*) filter (where state = 'new'),
      'learning', count(*) filter (where state = 'learning'),
      'review', count(*) filter (where state = 'review'),
      'relearning', count(*) filter (where state = 'relearning')
    ),
    'due', jsonb_build_object(
      'now', count(*) filter (where state <> 'new' and due <= now_ts),
      'tomorrow', count(*) filter (where state <> 'new' and due <= now_ts + interval '1 day'),
      'week', count(*) filter (where state <> 'new' and due <= now_ts + interval '7 days'),
      'month', count(*) filter (where state <> 'new' and due <= now_ts + interval '30 days')
    ),
    'avgStability', avg(stability) filter (where state = 'review'),
    'avgDifficulty', avg(difficulty) filter (where state = 'review')
  )
  into result
  from public.cards
  where include_in_practice
    and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid())
    and (p_deck_id is null or deck_id = p_deck_id);

  select result || jsonb_build_object(
    'reviews', jsonb_build_object(
      'today', count(*) filter (where reviewed_at >= date_trunc('day', now_ts)),
      'week', count(*) filter (where reviewed_at >= date_trunc('day', now_ts) - interval '6 days'),
      'all', count(*)
    ),
    'ratingsAll', jsonb_build_object(
      'again', count(*) filter (where rating = 1),
      'hard', count(*) filter (where rating = 2),
      'good', count(*) filter (where rating = 3),
      'easy', count(*) filter (where rating = 4)
    ),
    'ratingsToday', jsonb_build_object(
      'again', count(*) filter (where rating = 1 and reviewed_at >= date_trunc('day', now_ts)),
      'hard', count(*) filter (where rating = 2 and reviewed_at >= date_trunc('day', now_ts)),
      'good', count(*) filter (where rating = 3 and reviewed_at >= date_trunc('day', now_ts)),
      'easy', count(*) filter (where rating = 4 and reviewed_at >= date_trunc('day', now_ts))
    )
  )
  into result
  from public.review_log r
  join public.cards c on c.id = r.card_id
  where r.user_id = auth.uid()
    and (p_deck_id is null or c.deck_id = p_deck_id);

  return result;
end;
$$;

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
    where c.include_in_practice
      and c.deck_id = p_deck_id
      and exists (select 1 from public.decks d where d.id = c.deck_id and d.user_id = auth.uid())
    group by t
  ) x;
$$;
-- get_streak() is untouched — it only ever reads review_log, which keeps
-- its own real user_id column unchanged.

create or replace function public.approve_page_extraction(
  p_page_extraction_id uuid,
  p_force boolean default false,
  p_override_reason text default null
)
returns public.stacks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stacks;
  v_import_id uuid;
  v_all_approved boolean;
  v_has_warnings boolean;
begin
  select s.* into v_row
  from public.stacks s
  join public.import_pages ip on ip.id = s.source_page_id
  join public.imports i on i.id = ip.import_id
  where s.id = p_page_extraction_id and i.user_id = auth.uid() and public.is_admin()
  for update of s;

  if not found then
    raise exception 'page extraction not found, or you do not have permission to approve it';
  end if;

  v_has_warnings := jsonb_array_length(coalesce(v_row.unresolved_warnings, '[]'::jsonb)) > 0;

  if v_has_warnings and not p_force then
    raise exception 'cannot approve a page extraction with unresolved warnings without force=true';
  end if;

  if v_has_warnings and p_force and (p_override_reason is null or btrim(p_override_reason) = '') then
    raise exception 'a reason is required to approve a page with unresolved warnings';
  end if;

  update public.stacks
  set
    status = 'approved',
    reviewed_at = now(),
    reviewed_by = auth.uid(),
    updated_at = now(),
    approved_with_warnings = v_has_warnings,
    approval_override_reason = case when v_has_warnings then p_override_reason else null end
  where id = p_page_extraction_id
  returning * into v_row;

  select ip.import_id into v_import_id
  from public.import_pages ip
  where ip.id = v_row.source_page_id;

  -- "current extraction" per page = max version; approved only if every
  -- page's current extraction is itself approved.
  select not exists (
    select 1
    from public.import_pages ip
    join lateral (
      select s2.status
      from public.stacks s2
      where s2.source_page_id = ip.id
      order by s2.version desc
      limit 1
    ) current_s on true
    where ip.import_id = v_import_id and current_s.status <> 'approved'
  ) into v_all_approved;

  if v_all_approved then
    update public.imports set status = 'completed', updated_at = now() where id = v_import_id;
  end if;

  return v_row;
end;
$$;

grant execute on function public.approve_page_extraction(uuid, boolean, text) to authenticated;

-- ---------- 8. RLS on stacks / cards ----------

alter table public.stacks enable row level security;
alter table public.cards enable row level security;

drop policy if exists "page_extractions_own" on public.stacks;
drop policy if exists "page_blocks_own" on public.cards;

-- Same restrictiveness as today, no more and no less: a 'custom'/'manual'
-- row is owner-only (matches cards_own's bare owner check exactly — no
-- shared/published carve-out, even though notes_select had one; that carve-
-- out was never load-bearing since cards_own never had it and studying
-- requires cards, so adding it now would be a real behavior change hiding
-- inside a rename). A 'page'/'textbook_extraction' row keeps today's
-- page_blocks_own shape exactly (is_admin() AND owner, via
-- source_page_id -> import_pages -> imports).

create policy "stacks_select" on public.stacks for select using (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

create policy "stacks_insert" on public.stacks for insert with check (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

create policy "stacks_update" on public.stacks for update using (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
) with check (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

create policy "stacks_delete" on public.stacks for delete using (
  (kind = 'custom' and exists (select 1 from public.decks d where d.id = stacks.deck_id and d.user_id = auth.uid()))
  or
  (kind = 'page' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = stacks.source_page_id and i.user_id = auth.uid()
  ))
);

create policy "cards_select" on public.cards for select using (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

create policy "cards_insert" on public.cards for insert with check (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

create policy "cards_update" on public.cards for update using (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
) with check (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

create policy "cards_delete" on public.cards for delete using (
  (origin = 'manual' and exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = auth.uid()))
  or
  (origin = 'textbook_extraction' and public.is_admin() and exists (
    select 1 from public.import_pages ip
    join public.imports i on i.id = ip.import_id
    where ip.id = cards.source_page_id and i.user_id = auth.uid()
  ))
);

-- review_log_own is untouched (still flat user_id = auth.uid()) —
-- commitGrade always runs as the browsing user, never service-role, for
-- both origins.

-- ---------- 9. retire notes / cards_legacy_fsrs (kept, not dropped) ----------
-- Renamed to inert backups rather than DROPped — cheap rollback/diff safety
-- net for a migration this data-intensive (id-preserving transplants,
-- review_log remapping). A follow-up migration, run only after the app is
-- verified working end-to-end on the new schema, does
-- `drop table _legacy_notes_backup, _legacy_cards_backup cascade;`.

alter table public.notes drop constraint if exists notes_source_block_id_fkey;
drop index if exists notes_source_block_id_unique;

alter table public.notes rename to _legacy_notes_backup;
alter table public.cards_legacy_fsrs rename to _legacy_cards_backup;
