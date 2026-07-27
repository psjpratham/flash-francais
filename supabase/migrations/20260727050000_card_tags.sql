-- A small, organically-growing tag pool for page_blocks — broader than the
-- closed `category` label (which only drives icon/accent color): tags
-- classify a card's actual topic/skill (e.g. "food-and-drink",
-- "present-tense") so similar cards from other pages/units land in the same
-- group. Multiple tags per card, stored directly on page_blocks (same
-- text[] shape as the existing notes.tags). The `tags` table is the
-- canonical pool the extraction prompt is fed each run; the model may
-- propose a new one when nothing existing fits, which the pipeline then
-- upserts here so later pages see it too. RLS is auto-enabled on create
-- (see rls_auto_enable); the pipeline writes via its service-role client
-- (bypasses RLS), so only a read policy is needed for the app itself.

create table if not exists public.tags (
  name text primary key,
  created_at timestamptz not null default now()
);

insert into public.tags (name) values
  ('greetings'),
  ('numbers'),
  ('time-and-dates'),
  ('directions'),
  ('food-and-drink'),
  ('family'),
  ('daily-routine'),
  ('shopping'),
  ('travel'),
  ('weather'),
  ('housing'),
  ('present-tense'),
  ('past-tense'),
  ('future-tense'),
  ('grammar-basics'),
  ('pronunciation'),
  ('listening-comprehension'),
  ('reading-comprehension'),
  ('speaking-practice'),
  ('culture')
on conflict (name) do nothing;

create policy "tags_select_authenticated" on public.tags for select to authenticated using (true);

alter table public.page_blocks
  add column if not exists tags text[] not null default '{}';
