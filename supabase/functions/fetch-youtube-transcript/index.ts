// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

// User-invoked (not cron), synchronous "fetch this YouTube video's
// transcript" endpoint — called directly from the browser
// (supabase.functions.invoke) when a learner pastes a YouTube link into the
// import composer. Returns the transcript as plain text; the browser then
// feeds that text through the exact same upload/preprocess/extract pipeline
// a plain .txt source file already goes through (see pages/import.ts's
// startYoutubeImport) — this function's only job is turning a URL into
// text, nothing about card generation happens here.
//
// Auth: this function keeps the platform's default JWT verification
// (verify_jwt is NOT set to false in config.toml, same as tts-speak) —
// Supabase rejects an unauthenticated request before this code ever runs.
//
// The transcriptapi.com API key is server-side only (TRANSCRIPT_API_KEY) —
// never sent to or readable by the browser, same reasoning as GEMINI_API_KEY
// in tts-speak.

const TRANSCRIPT_API_URL = 'https://transcriptapi.com/api/v2/youtube/transcript';
const REQUEST_TIMEOUT_MS = 20_000;

// Same CORS reasoning as tts-speak: the browser preflights a cross-origin
// POST with OPTIONS first, and silently swallows the real error if that
// preflight isn't answered with these headers.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

interface TranscriptSegment {
  text: string;
}

interface TranscriptApiSuccess {
  video_id: string;
  language: string;
  transcript: TranscriptSegment[];
  metadata?: { title?: string; author_name?: string };
}

interface TranscriptApiError {
  detail?: string | { message?: string; reason?: string };
  code?: string;
  available_languages?: { code: string; name: string }[];
}

/** Maps transcriptapi.com's documented status codes (docs.transcriptapi.com/docs/api) to a message safe to show the learner — never the raw provider error, which can leak implementation detail (credit balances, rate-limit internals). */
function messageForStatus(status: number, body: TranscriptApiError): string {
  if (status === 400) return 'That doesn’t look like a valid YouTube link.';
  if (status === 401 || status === 402) {
    // Our provider account, not the learner's problem — logged for the admin, generic message shown.
    console.error('fetch-youtube-transcript: provider auth/credits error', status, body);
    return 'The transcript service is temporarily unavailable — try again later.';
  }
  if (status === 404) {
    const langs = body.available_languages?.map((l) => l.name).join(', ');
    return langs ? `This video has no transcript in the requested language(s) — available: ${langs}.` : 'This video has no transcript available.';
  }
  if (status === 408 || status === 429 || status === 503) return 'The transcript service is busy right now — try again in a moment.';
  return 'Could not fetch this video’s transcript.';
}

async function fetchTranscript(youtubeUrl: string, apiKey: string): Promise<{ transcript: string; title: string; videoId: string }> {
  const url = new URL(TRANSCRIPT_API_URL);
  url.searchParams.set('video_url', youtubeUrl);
  url.searchParams.set('format', 'json');
  url.searchParams.set('include_timestamp', 'false');
  url.searchParams.set('send_metadata', 'true');

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = (await res.json().catch(() => ({}))) as TranscriptApiSuccess & TranscriptApiError;
  if (!res.ok) throw new Error(messageForStatus(res.status, body));

  const segments = Array.isArray(body.transcript) ? body.transcript : [];
  // One real newline PER SEGMENT — critical, not cosmetic: the extraction
  // pipeline's chunker (sourceLines.ts's toSourceLines) splits a page's text
  // into ~6000-char requests by splitting on '\n' alone. Flattening every
  // segment into one space-joined blob (the previous approach) produced a
  // transcript with zero newlines, so a multi-minute video became a single
  // oversized request instead of many small ones — Gemini then timed out
  // generating a response for it (see gemini.ts's 60s REQUEST_TIMEOUT_MS).
  // Each segment's OWN internal whitespace (a caption line can itself
  // contain a '\n', e.g. "You know the rules\nand so do I") is still
  // collapsed to a single space — only the boundary BETWEEN segments must
  // survive as a real line break.
  const transcript = segments
    .map((s) => (typeof s.text === 'string' ? s.text.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean)
    .join('\n');
  if (!transcript) throw new Error('This video’s transcript came back empty.');

  return { transcript, title: body.metadata?.title?.trim() || `YouTube video ${body.video_id}`, videoId: body.video_id };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);

  let youtubeUrl: string | undefined;
  try {
    const body = await req.json();
    youtubeUrl = typeof body?.youtubeUrl === 'string' ? body.youtubeUrl.trim() : undefined;
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json_body' }, 400);
  }
  if (!youtubeUrl) return jsonResponse({ ok: false, error: 'Paste a YouTube link first.' }, 400);

  const apiKey = Deno.env.get('TRANSCRIPT_API_KEY');
  if (!apiKey) {
    console.error('fetch-youtube-transcript: missing TRANSCRIPT_API_KEY');
    return jsonResponse({ ok: false, error: 'server_misconfigured' }, 500);
  }

  try {
    const { transcript, title, videoId } = await fetchTranscript(youtubeUrl, apiKey);
    return jsonResponse({ ok: true, transcript, title, videoId }, 200);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not fetch this video’s transcript.';
    // A timeout (AbortSignal) surfaces as a generic AbortError, not one of
    // messageForStatus's mapped messages — still a clean, learner-safe string.
    return jsonResponse({ ok: false, error: message }, 502);
  }
});
