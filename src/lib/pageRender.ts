// Client-side PDF page rasterization — the "original page" pane's image
// source. This has to run in the browser: Supabase Edge Functions (Deno)
// have no canvas, so preprocess-import only extracts text/image-region
// metadata server-side. Runs after preprocessing, keyed off whichever pages
// don't have a rendered_page_path yet — safe to call again after a reload
// (it always re-downloads from storage, never depends on an in-memory File).

import * as pdfjsLib from 'pdfjs-dist';
// Vite ?url import: gives the worker script's built URL without bundling it
// as a JS module — the standard pattern for pdfjs-dist under Vite.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase } from './supabase';
import { listImportFiles, listImportPages, updateImportPageRender } from './imports';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const RENDER_SCALE = 2;
const RENDER_BUCKET = 'import-page-renders';

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), 'image/png');
  });
}

/**
 * Renders every usable page (extracted text or image-only) that has no
 * rendered_page_path yet, uploading each as a PNG to the private
 * import-page-renders bucket and recording the result on its import_pages
 * row. Idempotent — already-rendered pages are skipped, so calling this
 * again only fills in gaps.
 */
export async function renderPendingPageImages(importId: string): Promise<{ rendered: number }> {
  const [pages, files] = await Promise.all([listImportPages(importId), listImportFiles(importId)]);
  const textbookFile = files.find((f) => f.source_type === 'textbook');
  if (!textbookFile) return { rendered: 0 };

  const pending = pages.filter((p) => (p.extraction_status === 'extracted' || p.extraction_status === 'image_only') && !p.rendered_page_path);
  if (!pending.length) return { rendered: 0 };

  const { data: blob, error: downloadError } = await supabase.storage.from('import-sources').download(textbookFile.storage_path);
  if (downloadError || !blob) throw downloadError ?? new Error('could not download textbook file for rendering');

  const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;

  let rendered = 0;
  for (const page of pending) {
    const pdfPage = await pdf.getPage(page.page_index + 1);
    const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    await pdfPage.render({ canvasContext: ctx, viewport, canvas }).promise;

    const pngBlob = await canvasToBlob(canvas);
    const storagePath = `${importId}/${page.id}.png`;
    const { error: uploadError } = await supabase.storage.from(RENDER_BUCKET).upload(storagePath, pngBlob, {
      upsert: true,
      contentType: 'image/png',
    });
    if (uploadError) throw uploadError;

    await updateImportPageRender(page.id, { rendered_page_path: storagePath, width: canvas.width, height: canvas.height });
    rendered++;
  }

  return { rendered };
}

/** Signed URL for a rendered page image (bucket is private) — cached briefly by callers, not persisted. */
export async function getRenderedPageUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(RENDER_BUCKET).createSignedUrl(storagePath, 60 * 60);
  if (error || !data) throw error ?? new Error('could not create signed URL');
  return data.signedUrl;
}
