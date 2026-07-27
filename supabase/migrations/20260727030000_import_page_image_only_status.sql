-- Scanned/image-based textbook pages (no embedded PDF text layer) were
-- previously dead-ended as 'empty' and could never reach extraction, even
-- though the extraction call already attaches the page image and the model
-- can read text directly off it. 'image_only' marks a page with no text
-- layer but a working page-PDF slice as legitimately extractable, not a
-- failure — see preprocessWorker.ts / extractWorker.ts.

alter table public.import_pages
  drop constraint if exists import_pages_extraction_status_check,
  add constraint import_pages_extraction_status_check
    check (extraction_status = any (array['extracted'::text, 'empty'::text, 'image_only'::text, 'unreadable'::text]));
