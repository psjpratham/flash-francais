-- Lets an admin force a whole import through the image-only extraction path
-- (Gemini reading the page image directly, ignoring any embedded PDF text
-- layer) even on a page where pdf.js would have found text — a deliberate
-- A/B toggle for comparing card quality between the two paths, prompted by
-- unit 4 producing noticeably better cards once it fell back to image-only
-- extraction than earlier units did via the text-layer path.

alter table public.imports
  add column if not exists force_image_only boolean not null default false;
