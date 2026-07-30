// On-demand pronunciation audio (Gemini TTS) — see supabase/functions/tts-speak.
// Generate-on-first-click, cached from then on for every learner: the first
// tap for a given word/sentence pays the (small) generation latency, every
// tap after that — by anyone — gets the cached file back instantly.

import { supabase } from './supabase';

interface TtsSpeakResponse {
  ok: boolean;
  url?: string;
  cached?: boolean;
  error?: string;
}

// Caches the actual audio BYTES (as a blob: object URL), not just the
// signed URL string — a signed Supabase Storage URL still costs a real
// network fetch on every `new Audio(url).play()` even when the URL string
// itself is unchanged (its cache headers don't make the browser reuse the
// response), so caching only the URL still re-downloaded the file on every
// single tap. An object URL is backed by an in-memory Blob: once fetched,
// replaying it is instant, zero network, no matter how many times or how
// many cards reuse the same phrase. The Edge Function's tts_cache table is
// still the durable, cross-session/cross-user cache; this is the same-
// session, zero-latency layer on top of it.
const audioCache = new Map<string, string>();

/** Resolves a playable (object URL, already-downloaded) audio source for this exact text — generating it via Gemini TTS on first request, downloading it once, instant on every request after. Throws with a human-readable message on failure. */
export async function getSpokenAudioUrl(text: string): Promise<string> {
  const cached = audioCache.get(text);
  if (cached) return cached;

  const { data, error } = await supabase.functions.invoke<TtsSpeakResponse>('tts-speak', { body: { text } });
  if (error) throw new Error('Could not reach the pronunciation service.');
  if (!data?.ok || !data.url) throw new Error(data?.error ?? 'Pronunciation audio is not available for this yet.');

  const res = await fetch(data.url);
  if (!res.ok) throw new Error('Could not download pronunciation audio.');
  const objectUrl = URL.createObjectURL(await res.blob());

  audioCache.set(text, objectUrl);
  return objectUrl;
}
