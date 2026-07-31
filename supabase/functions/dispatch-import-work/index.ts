// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

// The durable server-side dispatcher — the only place import/extraction
// work actually happens. Invoked on a fixed schedule by pg_cron (via
// pg_net, see migration 20260726010000) so processing never depends on any
// browser tab staying open. Also safe to invoke manually (e.g. locally
// during testing) with the same header.
//
// Auth: a shared secret in the `x-cron-secret` header, checked against this
// function's own CRON_DISPATCH_SECRET env var (set once via
// `supabase secrets set`, never committed). Not a real user JWT — there is
// no user context for a cron tick — so this function's own
// SUPABASE_SERVICE_ROLE_KEY (auto-injected by the platform on every
// deployed function) builds a service-role client that bypasses RLS
// entirely, on purpose: a worker has to see every admin's queued work, not
// one specific user's.
//
// Bounded by design: loops claiming+processing preprocess jobs one at a
// time and extraction jobs in concurrent batches (every page's extraction
// is fully independent of every other page's — see
// processExtractionJobsBatch) until neither claims anything or a wall-clock
// budget is hit, then returns — satisfies "each worker invocation performs
// bounded work and exits safely" without needing any cross-invocation state.

import { createClient } from '@supabase/supabase-js';
import { processOnePreprocessJob, requeueStalePreprocessJobs } from '../_shared/preprocessWorker.ts';
import { processExtractionJobsBatch } from '../_shared/extractWorker.ts';

const BUDGET_MS = 45_000;
// How many pages to extract concurrently per tick. Bounded conservatively —
// each concurrent call holds a page-PDF attachment + prompt in memory and
// makes its own Gemini request; raise this once real throughput/rate-limit
// behavior at this batch size has been observed in production.
const EXTRACTION_BATCH_SIZE = 5;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);

  const expectedSecret = Deno.env.get('CRON_DISPATCH_SECRET');
  const providedSecret = req.headers.get('x-cron-secret');
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('dispatch-import-work: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ ok: false, error: 'server_misconfigured' }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const start = Date.now();
  let preprocessClaimed = 0;
  let extractClaimed = 0;
  let lastError: string | undefined;

  // Fallback safety net, not the primary mechanism: the bounded-batch
  // design in preprocessWorker.ts means a healthy preprocess_import job is
  // never 'processing' for anywhere near PREPROCESS_STALE_AFTER_MS. This
  // only matters if an invocation dies outright (platform kill, crash)
  // instead of returning cleanly.
  //
  // Deliberately NOT mirrored for extract_page — an earlier version of this
  // file auto-requeued stale extract_page jobs the same way, which turned
  // "one page kept failing" into "one page kept silently reattempting
  // forever, every tick, with no visibility into why" — exactly the
  // behavior an operator needs to be able to see and stop, not have hidden
  // behind automatic recovery. extract_page retries are manual only now:
  // the admin "Requeue stale jobs" / "Retry failed extraction" buttons
  // (src/lib/pageExtractions.ts), never this dispatcher.
  const requeuedStale = await requeueStalePreprocessJobs(supabase).catch(() => 0);

  for (;;) {
    if (Date.now() - start >= BUDGET_MS) break;

    const preResult = await processOnePreprocessJob(supabase);
    if (preResult.claimed) preprocessClaimed++;
    if (preResult.error) lastError = preResult.error;

    if (Date.now() - start >= BUDGET_MS) break;

    const extractResults = await processExtractionJobsBatch(supabase, EXTRACTION_BATCH_SIZE);
    extractClaimed += extractResults.filter((r) => r.claimed).length;
    const failedExtract = extractResults.find((r) => r.error);
    if (failedExtract) lastError = failedExtract.error;

    if (!preResult.claimed && extractResults.length === 0) break; // nothing left to do right now
  }

  console.log('dispatch-import-work: tick complete', { preprocessClaimed, extractClaimed, requeuedStale, elapsedMs: Date.now() - start });
  return jsonResponse({ ok: true, preprocessClaimed, extractClaimed, requeuedStale, lastError }, 200);
});
