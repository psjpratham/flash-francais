-- Lets an import carry an optional free-text prompt shaping how its pages
-- get extracted (reusing the exact "ADMIN INSTRUCTIONS" mechanism
-- extractWorker.ts already applies for the existing "re-extract with
-- instructions" feature — see prompts/pageExtraction.ts's adminInstructions
-- param — just threaded in at initial-extraction time too now, via
-- preprocessWorker.ts's ensureExtractionJobsExist).
--
-- A plain-text source (see preprocessWorker.ts's new text-source branch)
-- reuses the existing 'extracted' extraction_status as-is — it has a real
-- text layer (the whole file IS the text), just no page image — no new
-- status value needed.

alter table public.imports
  add column if not exists custom_prompt text;
