-- Two independent, additive changes:
--
-- 1. Generalizes "source" beyond PDF-only: import_pages.visual_mime_type
--    records what kind of file page_pdf_path/rendered_page_path actually
--    point at ('application/pdf' for the existing PDF-slice path, or a real
--    image mime type like 'image/png' for a plain-image source uploaded
--    with no PDF at all). Every existing row is a PDF slice, hence the
--    default. extractWorker.ts reads this instead of assuming PDF; a plain
--    image source skips PDF slicing/rasterization entirely and uses the
--    uploaded image directly as both the model's visual input and the
--    Manage/Study "original source" pane.
--
-- 2. Per-card "show source in practice" toggle: today every
--    textbook_extraction card unconditionally shows its source page
--    alongside it in Study/Practice. This makes that a per-card choice
--    instead, defaulting to true so existing behavior for already-extracted
--    cards doesn't regress.

alter table public.import_pages
  add column if not exists visual_mime_type text not null default 'application/pdf';

alter table public.cards
  add column if not exists show_source_in_practice boolean not null default true;
