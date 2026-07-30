-- Persists the learner's in-progress answer on an interactive card so Study
-- mode survives a re-render/reload instead of silently losing whatever was
-- typed/selected — see captureAnswerState/applyAnswerState in
-- readModeRenderers.ts. Shape is recipe-specific, an internal detail of
-- those two functions only.
alter table public.cards
  add column if not exists study_answer jsonb null;
