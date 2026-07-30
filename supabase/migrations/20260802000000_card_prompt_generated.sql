-- Marks a card as produced by prompt-driven generation mode (admin
-- instructions were attached at extraction time), independent of its
-- recipe. This is what gates the front/back flip in Practice/Study for
-- textbook_extraction cards, generalized beyond the 'flashcard' recipe to
-- every recipe generation mode can produce.
alter table public.cards
  add column if not exists prompt_generated boolean not null default false;
