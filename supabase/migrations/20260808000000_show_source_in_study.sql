-- Splits the single "show source in practice" toggle into two independent
-- ones: show_source_in_practice (Practice mode only, unchanged) and the new
-- show_source_in_study (Study mode only). Previously both modes shared one
-- flag; backfilled from the existing column so nothing visually regresses
-- for an already-extracted card until an admin deliberately changes one of
-- the two independently.
alter table public.cards
  add column if not exists show_source_in_study boolean not null default true;

update public.cards
  set show_source_in_study = show_source_in_practice
  where show_source_in_study is distinct from show_source_in_practice;
