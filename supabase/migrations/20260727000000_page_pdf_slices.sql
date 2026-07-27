-- Image-hybrid extraction, step 1: a private bucket + column for per-page
-- single-page PDF slices. Preprocessing already downloads the full textbook
-- PDF once per batch; this adds a byte-faithful one-page PDF copy per page
-- (via pdf-lib, no rasterization) so the extraction call can attach the
-- exact original page — vector graphics, exact fonts, no cropping/
-- recreation — as visual/structural context alongside the extracted text.
-- Same "<import_id>/<...>" key shape and RLS pattern as the other
-- import-* buckets.

alter table public.import_pages
  add column if not exists page_pdf_path text;

insert into storage.buckets (id, name, public)
values ('import-page-pdfs', 'import-page-pdfs', false)
on conflict (id) do nothing;

drop policy if exists "import_page_pdfs_own" on storage.objects;
create policy "import_page_pdfs_own" on storage.objects
  for all
  using (
    bucket_id = 'import-page-pdfs'
    and public.is_admin()
    and exists (
      select 1 from public.imports i
      where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'import-page-pdfs'
    and public.is_admin()
    and exists (
      select 1 from public.imports i
      where i.id::text = (storage.foldername(name))[1] and i.user_id = auth.uid()
    )
  );
