// Generic Gemini (Google Generative Language API) adapter for the
// image-hybrid extraction pipeline — mirrors deepseek.ts's call/outcome
// shape so extractWorker.ts can treat it as a drop-in replacement, but adds
// support for attaching inline binary data (the per-page single-page PDF
// slice) alongside the text prompt. DeepSeek (deepseek.ts) is untouched and
// still wired up for future card-generation/content-enrichment work — this
// file only replaces the *extraction* pipeline's provider.
//
// Model defaults to 'gemini-flash-lite-latest' (Google's self-updating
// flash-lite alias — see DEFAULT_MODEL below for why a pinned
// 'gemini-2.5-flash-lite' isn't used). Configurable via
// GEMINI_MODEL/GEMINI_MAX_OUTPUT_TOKENS without a code deploy.

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// 'gemini-2.5-flash-lite' returns 404 ("no longer available to new users")
// on this account — verified directly against the API. 'gemini-flash-lite-
// latest' is Google's self-updating flash-lite-tier alias (currently
// resolves to gemini-3.5-flash-lite) and is what's actually reachable here.
const DEFAULT_MODEL = 'gemini-flash-lite-latest';
// 8192 truncates mid-JSON on genuinely dense pages (verified directly: a
// grammar+vocabulary page needing ~22 blocks hit finishReason:MAX_TOKENS at
// 8192, producing an unterminated JSON string — not a random glitch, a
// deterministic budget problem, since the schema's verbose field names
// alone add real weight per block). 24576 leaves comfortable headroom above
// the ~8000 tokens that page actually needed once given room to finish.
const DEFAULT_MAX_OUTPUT_TOKENS = 24576;
// 100s was tried once and made things WORSE (a multi-chunk page's worst
// case exceeded Supabase's 150s free-tier per-invocation wall-clock
// ceiling, so the platform killed the function outright — no graceful
// error, job stuck in 'processing' forever). Chunking is now a rare
// fallback (extractWorker.ts's MAX_CHARS_PER_REQUEST=24000, one call for
// almost any real source), which removed the multi-chunk-stacking risk —
// but a single call generating close to GLOBAL_MAX_BLOCKS_PER_PAGE worth of
// verbose flashcards can still legitimately take over a minute (verified:
// ~100 blocks needed ~130s+ total across a truncate-and-retry cycle at 70s).
// 80s is a deliberate small bump, not a return to 100s — it has to stay
// well under the 150s whole-invocation ceiling alongside everything else
// processClaimedExtractionJob does in the same call (page/stacks
// reads/writes, audit/repair, polish, card inserts), which is exactly why
// GLOBAL_MAX_BLOCKS_PER_PAGE (extractWorker.ts) was lowered in the same
// change — this alone was not treated as sufficient on its own.
const REQUEST_TIMEOUT_MS = 80_000;

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface InlineData {
  mimeType: string;
  base64: string;
}

export interface GeminiCallOutcome {
  ok: true;
  content: string;
  /** 'MAX_TOKENS' means the response was cut off mid-generation — content is likely truncated/invalid, not just short. Callers can retry with a larger maxOutputTokens rather than assuming a content/formatting problem. */
  finishReason?: string;
  usage?: ProviderUsage;
  latencyMs: number;
  model: string;
}
export interface GeminiCallFailure {
  ok: false;
  error: string;
  latencyMs: number;
  model: string;
}

export function getConfiguredGeminiModel(): string {
  return Deno.env.get('GEMINI_MODEL') ?? DEFAULT_MODEL;
}

function getConfiguredMaxOutputTokens(): number {
  const raw = Deno.env.get('GEMINI_MAX_OUTPUT_TOKENS');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS;
}

function extractUsage(json: unknown): ProviderUsage | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const usage = (json as { usageMetadata?: unknown }).usageMetadata;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  return {
    promptTokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined,
    completionTokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : undefined,
    totalTokens: typeof u.totalTokenCount === 'number' ? u.totalTokenCount : undefined,
  };
}

function extractCandidate(json: unknown): { content?: { parts?: unknown }; finishReason?: unknown } | null {
  if (typeof json !== 'object' || json === null) return null;
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown };
}

function extractMessageContent(json: unknown): string | null {
  const parts = extractCandidate(json)?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join('');
  return text.trim() === '' ? null : text;
}

function extractFinishReason(json: unknown): string | undefined {
  const reason = extractCandidate(json)?.finishReason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * One call to Gemini's generateContent endpoint, optionally attaching
 * binary inline data (the page-PDF slice) as additional context alongside
 * the text prompt. Never throws — network/timeout failures and non-2xx
 * statuses become GeminiCallFailure, exactly like callDeepSeek.
 */
export async function callGemini(params: {
  systemPrompt: string;
  userPrompt: string;
  inlineData?: InlineData[];
  maxOutputTokens?: number;
}): Promise<GeminiCallOutcome | GeminiCallFailure> {
  const model = getConfiguredGeminiModel();
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return { ok: false, error: 'provider_not_configured', latencyMs: 0, model };

  const parts: Record<string, unknown>[] = [{ text: params.userPrompt }];
  for (const data of params.inlineData ?? []) {
    parts.push({ inline_data: { mime_type: data.mimeType, data: data.base64 } });
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: params.maxOutputTokens ?? getConfiguredMaxOutputTokens(),
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    return { ok: false, error: timedOut ? 'provider_timeout' : 'provider_unreachable', latencyMs: Date.now() - started, model };
  }
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const label =
      res.status === 401 || res.status === 403
        ? 'provider_auth_failed'
        : res.status === 429
          ? 'provider_rate_limited'
          : res.status >= 500
            ? 'provider_unavailable'
            : 'provider_error';
    return { ok: false, error: `${label}: gemini http ${res.status}`, latencyMs, model };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'provider_bad_response', latencyMs, model };
  }

  const content = extractMessageContent(json);
  if (content == null) {
    return { ok: false, error: 'provider response missing message content', latencyMs, model };
  }

  return { ok: true, content, finishReason: extractFinishReason(json), usage: extractUsage(json), latencyMs, model };
}

export function parseJsonContent(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false, error: 'model content was not valid JSON' };
  }
}
