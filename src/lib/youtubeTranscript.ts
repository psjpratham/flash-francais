// See supabase/functions/fetch-youtube-transcript — server-side call to
// transcriptapi.com, keeping TRANSCRIPT_API_KEY out of the browser entirely.

import { supabase } from './supabase';

interface FetchYoutubeTranscriptResponse {
  ok: boolean;
  transcript?: string;
  title?: string;
  videoId?: string;
  error?: string;
}

export interface YoutubeTranscriptResult {
  transcript: string;
  title: string;
  videoId: string;
}

/** Fetches a YouTube video's transcript. Throws with a human-readable message on failure (bad link, no transcript available, provider down). */
export async function fetchYoutubeTranscript(youtubeUrl: string): Promise<YoutubeTranscriptResult> {
  const { data, error } = await supabase.functions.invoke<FetchYoutubeTranscriptResponse>('fetch-youtube-transcript', { body: { youtubeUrl } });
  if (error) throw new Error('Could not reach the transcript service.');
  if (!data?.ok || !data.transcript) throw new Error(data?.error ?? 'Could not fetch this video’s transcript.');
  return { transcript: data.transcript, title: data.title ?? 'YouTube video', videoId: data.videoId ?? '' };
}
