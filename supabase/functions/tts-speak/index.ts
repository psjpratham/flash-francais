// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

// User-invoked (not cron), synchronous "get or generate audio for this
// text" endpoint — the only place TTS actually happens. Called directly
// from the browser (supabase.functions.invoke) the first time a learner
// taps a pronunciation icon for a given word/sentence; every tap after
// that, by any learner, hits the cache and never calls Gemini again.
//
// Auth: this function keeps the platform's default JWT verification
// (verify_jwt is NOT set to false in config.toml, unlike dispatch-import-
// work) — Supabase rejects an unauthenticated request before this code
// ever runs, so there is no per-user identity check to do here. Once past
// that gate, a service-role client is used for the cache table/bucket
// (tts_cache has zero RLS policies — see its migration — so only a
// service-role client can touch it at all, by design; no client is ever
// meant to query it directly).
//
// Cached by a hash of the exact spoken text, never per-card — the same
// word/sentence reused across different cards/decks/learners is only ever
// synthesized once. See supabase/migrations/20260806000000_tts_cache.sql.

import { createClient } from '@supabase/supabase-js';
import { decodeBase64 } from '@std/encoding/base64';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// Cheapest + lowest-latency of Gemini's native TTS models (~200ms first-byte
// vs Pro's ~450ms, and roughly half the per-token cost) — see GEMINI_TTS_MODEL
// to override without a redeploy if this preview model is ever retired.
const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE = 'Kore';
const REQUEST_TIMEOUT_MS = 30_000;
const BUCKET = 'tts-cache';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

// A language-learning app needs clearly-enunciated, modeled pronunciation,
// not slurred casual delivery — but "slower than native speech" (the
// original wording here) came back genuinely slow, even for a beginner.
// Normal conversational pace with clear enunciation reads much more
// naturally without sacrificing clarity. Baked in server-side (never
// client-supplied) so every generated clip sounds consistent.
const STYLE_INSTRUCTION =
  'a normal, natural conversational pace — like a teacher clearly pronouncing a word or phrase for a student, not slowed down or drawn out. Standard Parisian French pronunciation, enunciate clearly';
// Bump whenever STYLE_INSTRUCTION (or the voice/model) changes meaningfully
// — folded into the cache key below so a wording/pace change automatically
// invalidates every previously-cached clip instead of silently leaving old
// (e.g. too-slow) audio being served forever under the same text hash.
const STYLE_VERSION = 'v2-normal-pace';

// Only dispatch-import-work existed before this function — that one's
// server-to-server (pg_cron/pg_net), so CORS never came up. This is the
// first Edge Function invoked directly from the browser (supabase.functions
// .invoke): the browser preflights a cross-origin POST with an OPTIONS
// request first, and refuses to even show the app's own fetch call an error
// if that preflight isn't answered with the right headers — silently
// blocked, not a visible failure. Both the OPTIONS handling below and these
// headers on every real response are required, not optional.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Gemini TTS returns raw 16-bit PCM (24kHz, mono, per Google's docs) — never directly playable via <audio>/new Audio(), so it's wrapped in a standard 44-byte WAV header before it's ever stored. */
function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): Uint8Array {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, pcm.length, true);
  const out = new Uint8Array(buffer);
  out.set(pcm, 44);
  return out;
}

async function synthesizeWav(text: string): Promise<Uint8Array> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('provider_not_configured');
  const model = Deno.env.get('GEMINI_TTS_MODEL') ?? DEFAULT_MODEL;
  const voiceName = Deno.env.get('GEMINI_TTS_VOICE') ?? DEFAULT_VOICE;

  const res = await fetch(`${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Say, in ${STYLE_INSTRUCTION}, exactly this and nothing else: "${text}"` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gemini_tts_http_${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const base64Pcm = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (typeof base64Pcm !== 'string') throw new Error('gemini_tts_no_audio_in_response');
  return pcmToWav(decodeBase64(base64Pcm));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);

  let text: string | undefined;
  try {
    const body = await req.json();
    text = typeof body?.text === 'string' ? body.text.trim() : undefined;
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json_body' }, 400);
  }
  if (!text) return jsonResponse({ ok: false, error: 'missing_text' }, 400);
  if (text.length > 500) return jsonResponse({ ok: false, error: 'text_too_long' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('tts-speak: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ ok: false, error: 'server_misconfigured' }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const hash = await sha256Hex(`${STYLE_VERSION}::${text}`);
  const storagePath = `${hash}.wav`;

  const { data: existing } = await supabase.from('tts_cache').select('storage_path').eq('text_hash', hash).maybeSingle();

  if (!existing) {
    let wav: Uint8Array;
    try {
      wav = await synthesizeWav(text);
    } catch (e) {
      console.error('tts-speak: synthesis failed', e);
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : 'synthesis_failed' }, 502);
    }

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, wav, { contentType: 'audio/wav', upsert: true });
    if (uploadError) {
      console.error('tts-speak: upload failed', uploadError);
      return jsonResponse({ ok: false, error: 'upload_failed' }, 500);
    }

    // Best-effort — a unique-violation here just means a concurrent request
    // won the race and already inserted this exact hash; the file at
    // storagePath is equivalent either way (same text, same deterministic
    // path), so there's nothing to reconcile.
    const { error: insertError } = await supabase.from('tts_cache').insert({ text_hash: hash, source_text: text, storage_path: storagePath });
    if (insertError && insertError.code !== '23505') {
      console.error('tts-speak: cache row insert failed', insertError);
    }
  }

  const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (signError || !signed) {
    console.error('tts-speak: sign failed', signError);
    return jsonResponse({ ok: false, error: 'sign_failed' }, 500);
  }

  return jsonResponse({ ok: true, url: signed.signedUrl, cached: !!existing }, 200);
});
