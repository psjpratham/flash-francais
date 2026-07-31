-- A new answer_key_status value: 'inferred' — the model answered an item
-- itself because it's confident/objective (grammar conjugation, vocabulary,
-- an unambiguous fact), when the attached answer key didn't cover that
-- specific item. Kept distinct from 'available' (confirmed by the real
-- answer key) so the UI can always tell the difference — Verify still
-- works either way, but 'inferred' is never presented as key-confirmed.
alter table public.cards drop constraint if exists page_blocks_answer_key_status_check;
alter table public.cards add constraint page_blocks_answer_key_status_check
  check (answer_key_status = any (array['available', 'unavailable', 'unknown', 'inferred']));
