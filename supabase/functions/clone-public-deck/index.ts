// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

// "Add to my decks": makes a complete, independent, physical copy of a
// public deck — every card (manual AND textbook-extraction origin, unlike
// an earlier version of this that silently dropped the latter), every
// referenced source page, and every referenced image/audio FILE the learner
// actually sees or hears (not just the DB row pointing at it) — into a
// brand-new deck owned by the caller, with fresh FSRS state (new cards,
// never studied). Deliberately excludes each page's PDF slice
// (import_pages.page_pdf_path) — that file is purely an internal
// extraction-pipeline artifact (the visual context attached to the LLM
// extraction call) that no client code ever reads or renders, so copying it
// would just be wasted download/upload time on every clone for zero
// user-visible benefit.
//
// Why this can't be a plain SQL function (unlike clone_public_deck used to
// be): storage.objects only holds file METADATA — the actual bytes live
// outside Postgres, in Supabase's S3-backed storage, reachable only via the
// Storage API. A SECURITY DEFINER SQL function can bypass RLS on tables all
// day, but it cannot download-and-reupload a file. That has to happen here,
// with the service-role key.
//
// Why the destination path has to be a fresh <new_import_id>/... prefix,
// not a byte-identical copy at the old path: storage RLS on every one of
// these buckets keys off (storage.foldername(name))[1] matching an
// `imports` row the reader owns (see 20260725150000_generic_audio_and_
// render_storage.sql and 20260727000000_page_pdf_slices.sql) — re-pathing
// under a new, caller-owned `imports` row is what makes the copy actually
// readable by its new owner afterward, not just present in the bucket.
//
// Auth: platform default JWT verification (verify_jwt stays at its default
// `true` — no override in config.toml), so an unauthenticated request never
// reaches this code. The caller's own identity is still needed (whose
// library the copy lands in), which this function gets by building a
// second, anon-key client bound to the incoming Authorization header and
// calling auth.getUser() on it — everything else uses a service-role
// client, since the whole point is copying rows/files the caller doesn't
// have direct RLS access to read.

import { createClient } from '@supabase/supabase-js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

const BUCKET_RENDERS = 'import-page-renders';
const BUCKET_AUDIO = 'import-audio';

/** Downloads a file and re-uploads it under a new path, in the same bucket. Throws on either failure. */
async function copyStorageObject(
  // deno-lint-ignore no-explicit-any
  admin: any,
  bucket: string,
  fromPath: string,
  toPath: string,
  contentType?: string,
): Promise<void> {
  const { data: blob, error: downloadError } = await admin.storage.from(bucket).download(fromPath);
  if (downloadError || !blob) throw new Error(`download_failed(${bucket}/${fromPath}): ${downloadError?.message ?? 'no data'}`);
  const { error: uploadError } = await admin.storage.from(bucket).upload(toPath, blob, { contentType: contentType ?? blob.type, upsert: true });
  if (uploadError) throw new Error(`upload_failed(${bucket}/${toPath}): ${uploadError.message}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);

  let sourceDeckId: string | undefined;
  let requestedName: string | null | undefined;
  try {
    const body = await req.json();
    sourceDeckId = typeof body?.sourceDeckId === 'string' ? body.sourceDeckId : undefined;
    requestedName = typeof body?.name === 'string' ? body.name : null;
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json_body' }, 400);
  }
  if (!sourceDeckId) return jsonResponse({ ok: false, error: 'missing_sourceDeckId' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authHeader = req.headers.get('Authorization');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('clone-public-deck: missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ ok: false, error: 'server_misconfigured' }, 500);
  }
  if (!authHeader) return jsonResponse({ ok: false, error: 'missing_authorization' }, 401);

  const asCaller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user },
    error: userError,
  } = await asCaller.auth.getUser();
  if (userError || !user) return jsonResponse({ ok: false, error: 'not_authenticated' }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Cloneable either because its author opted it into public discovery
  // (is_public) or because it's one of the admin-curated defaults every
  // user gets (visibility='shared') — the latter is what makes
  // ensureDefaultDecksCloned's per-login catch-up clone possible at all.
  const { data: sourceDeck, error: sourceDeckError } = await admin
    .from('decks')
    .select('*')
    .eq('id', sourceDeckId)
    .eq('status', 'published')
    .or('is_public.eq.true,visibility.eq.shared')
    .maybeSingle();
  if (sourceDeckError) return jsonResponse({ ok: false, error: sourceDeckError.message }, 500);
  if (!sourceDeck) return jsonResponse({ ok: false, error: 'Deck not found or not public' }, 404);

  const { data: newDeck, error: newDeckError } = await admin
    .from('decks')
    .insert({
      user_id: user.id,
      name: requestedName?.trim() || sourceDeck.name,
      source: sourceDeck.source,
      desired_retention: sourceDeck.desired_retention,
      new_per_day: sourceDeck.new_per_day,
      review_per_day: sourceDeck.review_per_day,
      visibility: 'personal',
      status: 'published',
      is_public: false,
      cloned_from_deck_id: sourceDeck.id,
    })
    .select()
    .single();
  if (newDeckError || !newDeck) return jsonResponse({ ok: false, error: newDeckError?.message ?? 'deck_insert_failed' }, 500);

  // From here on, any failure rolls back the partially-created deck (cascade
  // deletes everything under it — cards/stacks/imports/import_pages/
  // import_audio_files all FK to decks/imports with ON DELETE CASCADE) so a
  // failed clone never leaves a half-populated deck behind.
  try {
    const { data: sourceCards, error: sourceCardsError } = await admin
      .from('cards')
      .select('*')
      .eq('deck_id', sourceDeckId)
      .order('stack_id', { ascending: true })
      .order('order_index', { ascending: true });
    if (sourceCardsError) throw new Error(sourceCardsError.message);

    const manualCards = (sourceCards ?? []).filter((c) => c.origin === 'manual');
    const extractedCards = (sourceCards ?? []).filter((c) => c.origin === 'textbook_extraction');
    let clonedCount = 0;

    // ---- manual-origin cards: all land in one fresh "Manual cards" stack ----
    if (manualCards.length) {
      const { data: manualStack, error: manualStackError } = await admin
        .from('stacks')
        .insert({ deck_id: newDeck.id, name: 'Manual cards', kind: 'custom', version: 1 })
        .select('id')
        .single();
      if (manualStackError || !manualStack) throw new Error(manualStackError?.message ?? 'manual_stack_insert_failed');

      const rows = manualCards.map((c, i) => ({
        stack_id: manualStack.id,
        deck_id: newDeck.id,
        order_index: i,
        origin: 'manual',
        note_type: c.note_type,
        fields: c.fields,
        review_status: c.review_status,
        confidence: c.confidence,
        review_reasons: c.review_reasons,
        source_evidence: c.source_evidence,
        extraction_diagnostics: c.extraction_diagnostics,
        tags: c.tags,
        // Faithfully copied, not forced true — if the original author never
        // sent this card to practice, the clone shouldn't show up in the
        // new owner's practice queue either.
        include_in_practice: c.include_in_practice,
      }));
      const { error: insertError } = await admin.from('cards').insert(rows);
      if (insertError) throw new Error(insertError.message);
      clonedCount += rows.length;
    }

    // ---- textbook-extraction-origin cards: full copy, including source pages + files ----
    if (extractedCards.length) {
      const stackIds = [...new Set(extractedCards.map((c) => c.stack_id))];
      const { data: sourceStacks, error: sourceStacksError } = await admin.from('stacks').select('*').in('id', stackIds);
      if (sourceStacksError) throw new Error(sourceStacksError.message);

      const pageIds = [...new Set(extractedCards.map((c) => c.source_page_id).filter((id): id is string => !!id))];
      const { data: sourcePages, error: sourcePagesError } = await admin
        .from('import_pages')
        .select('*')
        .in('id', pageIds)
        .order('import_id', { ascending: true })
        .order('page_index', { ascending: true });
      if (sourcePagesError) throw new Error(sourcePagesError.message);

      const originalImportIds = [...new Set((sourcePages ?? []).map((p) => p.import_id))];
      const { data: sourceImports, error: sourceImportsError } = await admin.from('imports').select('*').in('id', originalImportIds);
      if (sourceImportsError) throw new Error(sourceImportsError.message);

      // ---- one new `imports` row PER ORIGINAL import, not one merged blob ----
      // Manage-content and Study both group + label everything by import
      // (see listStackTilesForDeck in src/lib/stacks.ts) — a deck built from
      // several separate imports (e.g. "U4 - Textbook", "Prepositions de
      // lieu", "Lieux en ville") needs to keep looking like three separate,
      // properly-named imports on the clone too. An earlier version of this
      // merged everything into a single import titled `Cloned from "..."`,
      // which flattened that real structure into one lump — not what
      // "faithful copy" means.
      const importIdMap = new Map<string, string>();
      await Promise.all(
        (sourceImports ?? []).map(async (imp) => {
          const pageCount = (sourcePages ?? []).filter((p) => p.import_id === imp.id).length;
          const { data: newImportRow, error: newImportError } = await admin
            .from('imports')
            .insert({
              user_id: user.id,
              deck_id: newDeck.id,
              title: imp.title,
              status: 'completed',
              total_pages: pageCount,
              pages_discovered: pageCount,
              pages_prepared: pageCount,
              force_image_only: imp.force_image_only,
              custom_prompt: imp.custom_prompt,
            })
            .select('id')
            .single();
          if (newImportError || !newImportRow) throw new Error(newImportError?.message ?? 'import_insert_failed');
          importIdMap.set(imp.id, newImportRow.id);
        }),
      );

      // ---- audio files, grouped under their own original import's clone ----
      const { data: sourceAudio, error: sourceAudioError } = originalImportIds.length
        ? await admin.from('import_audio_files').select('*').in('import_id', originalImportIds)
        : { data: [], error: null };
      if (sourceAudioError) throw new Error(sourceAudioError.message);

      // File copies run in parallel (per audio file / per page) rather than
      // one-at-a-time — a textbook import can easily have 30-60 page images,
      // and sequential download+upload of each was slow enough to trip the
      // edge function's execution time limit on a real deck (the empty test
      // deck used earlier never exercised this path at all).
      const audioIdMap = new Map<string, string>();
      await Promise.all(
        (sourceAudio ?? []).map(async (a) => {
          const newImportId = importIdMap.get(a.import_id);
          if (!newImportId) return; // every audio file's import_id is one of originalImportIds by construction
          const newPath = `${newImportId}/${crypto.randomUUID()}-${a.normalized_filename}`;
          await copyStorageObject(admin, BUCKET_AUDIO, a.storage_path, newPath);
          const { data: newAudio, error: newAudioError } = await admin
            .from('import_audio_files')
            .insert({
              import_id: newImportId,
              original_filename: a.original_filename,
              normalized_filename: a.normalized_filename,
              track_number: a.track_number,
              storage_path: newPath,
              duration: a.duration,
            })
            .select('id')
            .single();
          if (newAudioError || !newAudio) throw new Error(newAudioError?.message ?? 'audio_insert_failed');
          audioIdMap.set(a.id, newAudio.id);
        }),
      );

      // ---- pages + their rendered image ----
      // page_pdf_path is never read anywhere client-side (grep confirms —
      // it's a purely internal extraction-pipeline artifact, the visual
      // context attached to the LLM extraction call, never shown to a
      // learner) — skipped entirely here, both because it'd be wasted work
      // and because nothing about "faithful copy of what the user sees" is
      // lost by leaving it null on the clone.
      //
      // page_index is reassigned sequentially per NEW import group (0..N-1
      // within each), not copied from the source — import_pages has a
      // unique (import_id, page_index) constraint, and while each page now
      // lands under its own import's clone (matching the source 1:1), the
      // original page_index values are otherwise arbitrary bookkeeping
      // (the "Page N" label shown in the UI comes from the copied stack
      // `name`, not from page_index). sourcePages is fetched pre-sorted by
      // (import_id, page_index), and this counter increment happens before
      // any `await` in each callback, so — even though the callbacks below
      // run concurrently — the counters themselves are assigned in that
      // same deterministic per-group order, never raced.
      const pageIndexCounters = new Map<string, number>();
      const pageIdMap = new Map<string, string>();
      await Promise.all(
        (sourcePages ?? []).map(async (p) => {
          const newImportId = importIdMap.get(p.import_id)!;
          const newPageIndex = pageIndexCounters.get(newImportId) ?? 0;
          pageIndexCounters.set(newImportId, newPageIndex + 1);

          let newRenderedPath: string | null = null;
          if (p.rendered_page_path) {
            newRenderedPath = `${newImportId}/${crypto.randomUUID()}.png`;
            await copyStorageObject(admin, BUCKET_RENDERS, p.rendered_page_path, newRenderedPath, 'image/png');
          }
          const { data: newPage, error: newPageError } = await admin
            .from('import_pages')
            .insert({
              import_id: newImportId,
              page_index: newPageIndex,
              source_type: p.source_type,
              filename: p.filename,
              displayed_page_number: p.displayed_page_number,
              text: p.text,
              extraction_status: p.extraction_status,
              rendered_page_path: newRenderedPath,
              width: p.width,
              height: p.height,
              image_regions: p.image_regions,
              page_pdf_path: null,
              visual_mime_type: p.visual_mime_type,
            })
            .select('id')
            .single();
          if (newPageError || !newPage) throw new Error(newPageError?.message ?? 'page_insert_failed');
          pageIdMap.set(p.id, newPage.id);
        }),
      );

      // ---- stacks (kind='page') ----
      // status must be carried over, not left to default to 'pending' — a
      // public deck's stacks are already reviewed/approved, and a 'pending'/
      // 'processing' status is exactly what the Manage-content UI reads as
      // "extracting…" (see STATUS_RANK in src/lib/stacks.ts), which made a
      // fully-copied, fully-usable clone look stuck mid-extraction.
      const stackIdMap = new Map<string, string>();
      await Promise.all(
        (sourceStacks ?? []).map(async (s) => {
          const newSourcePageId = s.source_page_id ? (pageIdMap.get(s.source_page_id) ?? null) : null;
          const { data: newStack, error: newStackError } = await admin
            .from('stacks')
            .insert({
              deck_id: newDeck.id,
              name: s.name,
              kind: s.kind,
              source_page_id: newSourcePageId,
              version: 1,
              status: s.status,
              model: s.model,
              prompt_version: s.prompt_version,
              approved_with_warnings: s.approved_with_warnings,
              approval_override_reason: s.approval_override_reason,
            })
            .select('id')
            .single();
          if (newStackError || !newStack) throw new Error(newStackError?.message ?? 'page_stack_insert_failed');
          stackIdMap.set(s.id, newStack.id);
        }),
      );

      // ---- re-link merged_stack_id for image-source imports ----
      // An image-source import has no source_page_id trail at all — its
      // whole `imports` row is tied to its one shared kind='custom' stack
      // purely via imports.merged_stack_id (see createImport in
      // src/lib/imports.ts). Without setting this on the clone too,
      // listStacksForDeck can never find it via merged_stack_id (it's null
      // by default on the freshly-inserted import row above), so the
      // group falls out of "📚 Imports" entirely and gets misfiled under
      // "🗂️ Stacks made by hand", labeled with the raw stack name instead
      // of the import's real title.
      await Promise.all(
        (sourceImports ?? []).map(async (imp) => {
          if (!imp.merged_stack_id) return;
          const newImportId = importIdMap.get(imp.id);
          const newStackId = stackIdMap.get(imp.merged_stack_id);
          if (!newImportId || !newStackId) return;
          const { error: relinkError } = await admin.from('imports').update({ merged_stack_id: newStackId }).eq('id', newImportId);
          if (relinkError) throw new Error(relinkError.message);
        }),
      );

      // ---- cards themselves ----
      const rows = extractedCards.map((c, i) => {
        // deno-lint-ignore no-explicit-any
        let content: any = c.content;
        if (content && typeof content === 'object' && content.matchedAudioAssetId) {
          content = { ...content, matchedAudioAssetId: audioIdMap.get(content.matchedAudioAssetId) ?? null };
        }
        return {
          stack_id: stackIdMap.get(c.stack_id),
          deck_id: newDeck.id,
          order_index: i,
          origin: 'textbook_extraction',
          source_page_id: c.source_page_id ? (pageIdMap.get(c.source_page_id) ?? null) : null,
          block_kind: c.block_kind,
          component_type: c.component_type,
          section_number: c.section_number,
          title: c.title,
          instruction: c.instruction,
          language: c.language,
          source_line_ids: c.source_line_ids,
          source_text: c.source_text,
          content,
          translation: c.translation,
          category: c.category,
          answer_key_status: c.answer_key_status,
          prompt_generated: c.prompt_generated,
          pronunciation_enabled: c.pronunciation_enabled,
          activity_audio_reference: c.activity_audio_reference,
          needs_review: c.needs_review,
          review_reason: c.review_reason,
          show_source_in_practice: c.show_source_in_practice,
          show_source_in_study: c.show_source_in_study,
          tags: c.tags,
          // Faithfully copied, not forced true — if the original author
          // never sent this card to practice, the clone shouldn't show up
          // in the new owner's practice queue either.
          include_in_practice: c.include_in_practice,
        };
      });
      const { error: cardsInsertError } = await admin.from('cards').insert(rows);
      if (cardsInsertError) throw new Error(cardsInsertError.message);
      clonedCount += rows.length;
    }

    return jsonResponse({ ok: true, deck: newDeck, cardCount: clonedCount }, 200);
  } catch (e) {
    console.error('clone-public-deck: failed mid-clone, rolling back new deck', newDeck.id, e);
    await admin.from('decks').delete().eq('id', newDeck.id);
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : 'clone_failed' }, 500);
  }
});
