// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

// Permanently deletes the caller's own account. Deleting the auth.users row
// cascades (ON DELETE CASCADE) through every owned table — profiles, decks,
// cards, notes, imports, jobs, review_log, see
// 20260724220036_remote_schema.sql — so no manual row cleanup is needed
// there. Storage objects are NOT part of that FK graph (same reasoning as
// deleteDeckDeep in src/lib/decks.ts), so this walks every deck the caller
// owns and removes their storage objects first, then deletes the user.
//
// Why this has to be an edge function, not a plain RPC: deleting an
// auth.users row (supabase.auth.admin.deleteUser) requires the service-role
// key — never something a client-callable SQL function can hold.
//
// Auth: platform default JWT verification (verify_jwt stays at its default
// `true` — no override in config.toml), so an unauthenticated request never
// reaches this code. The caller's own identity is still needed, gotten the
// same way as clone-public-deck: a second, anon-key client bound to the
// incoming Authorization header, calling auth.getUser() on it.

import { createClient } from '@supabase/supabase-js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authHeader = req.headers.get('Authorization');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('delete-account: missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY');
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

  try {
    const { data: decks, error: decksError } = await admin.from('decks').select('id').eq('user_id', user.id);
    if (decksError) throw new Error(decksError.message);

    const deckIds = (decks ?? []).map((d) => d.id);
    if (deckIds.length) {
      const { data: imports, error: importsError } = await admin.from('imports').select('id').in('deck_id', deckIds);
      if (importsError) throw new Error(importsError.message);

      const importIds = (imports ?? []).map((i) => i.id);
      if (importIds.length) {
        const { data: files } = await admin.from('import_files').select('storage_path').in('import_id', importIds);
        if (files?.length) await admin.storage.from('import-sources').remove(files.map((f) => f.storage_path));

        const { data: audioFiles } = await admin.from('import_audio_files').select('storage_path').in('import_id', importIds);
        if (audioFiles?.length) await admin.storage.from('import-audio').remove(audioFiles.map((f) => f.storage_path));

        const { data: pages } = await admin
          .from('import_pages')
          .select('rendered_page_path')
          .in('import_id', importIds)
          .not('rendered_page_path', 'is', null);
        if (pages?.length) await admin.storage.from('import-page-renders').remove(pages.map((p) => p.rendered_page_path as string));
      }
    }

    const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteUserError) throw new Error(deleteUserError.message);

    return jsonResponse({ ok: true }, 200);
  } catch (e) {
    console.error('delete-account: failed for user', user.id, e);
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : 'delete_failed' }, 500);
  }
});
