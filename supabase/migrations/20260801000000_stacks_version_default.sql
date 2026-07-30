-- `stacks.version` is NOT NULL with no default. That's correct for a
-- kind='page' stack, where version is a meaningful, explicitly-computed
-- revision counter per source page (see extractWorker.ts). It was never
-- meaningful for a kind='custom' stack (the "Manual cards" bucket,
-- getOrCreateManualStack in cards.ts; the shared image-import stack,
-- createImport in imports.ts) — both call sites simply omitted it, which
-- worked only as long as nothing actually exercised that insert. Once an
-- image-source import made that path deterministic (no longer gated behind
-- an opt-in toggle), the omission surfaced as a real NOT NULL violation.
--
-- A default of 1 fixes both existing call sites without touching them, and
-- guards against a future custom-stack insert making the same omission.
-- Application code still passes version: 1 explicitly at both sites too,
-- for readability — the default is a safety net, not the primary fix.

alter table public.stacks alter column version set default 1;
