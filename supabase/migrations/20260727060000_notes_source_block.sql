-- Bridges the import pipeline (page_blocks) into the pre-existing FSRS
-- practice system (notes/cards): an admin explicitly "sends" a page's
-- (already reordered) blocks to practice, one note+card per block, each
-- tagged back to its source block. The unique partial index makes sending
-- idempotent — re-sending a page only picks up blocks not already sent.
--
-- This deliberately references page_blocks live (source_block_id), not a
-- content snapshot: the person creating an import is the same admin who
-- studies it, so RLS (page_blocks_own / import_page_renders_own, both
-- "is_admin() and owns the import") is never a barrier in practice. A
-- separate non-admin learner role would need a snapshot or a service-role
-- read path instead — out of scope until that role actually exists.

alter table public.notes
  add column if not exists source_block_id uuid references public.page_blocks(id) on delete set null;

create unique index if not exists notes_source_block_id_unique
  on public.notes (source_block_id) where source_block_id is not null;
