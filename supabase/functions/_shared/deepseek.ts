// Generic DeepSeek chat-completion adapter shared by extraction/audit/repair
// calls. This is the only place a provider needs to be wired in.
//
// Model defaults to 'deepseek-v4-flash'. The generic 'deepseek-chat'
// non-thinking alias is NOT valid on this account — verified directly
// against the API: "The supported API model names are deepseek-v4-pro or
// deepseek-v4-flash". Both default to always-thinking mode (emitting
// reasoning_content before the real answer — this is what made a single
// extraction job take minutes in production), but both accept an explicit
// `thinking: {type: 'disabled'}` toggle (also verified live) that turns
// this off entirely — exactly what mechanical, temperature-0 transcription
// needs. max_tokens is kept generous as a safety ceiling regardless (cheap
// — it's a cap, not a pre-allocation). Configurable via
// DEEPSEEK_MODEL/DEEPSEEK_MAX_OUTPUT_TOKENS without a code deploy.

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface DeepSeekCallOutcome {
  ok: true;
  json: unknown;
  content: string;
  usage?: ProviderUsage;
  latencyMs: number;
  model: string;
}
export interface DeepSeekCallFailure {
  ok: false;
  error: string;
  latencyMs: number;
  model: string;
}

function extractUsage(providerJson: unknown): ProviderUsage | undefined {
  if (typeof providerJson !== 'object' || providerJson === null) return undefined;
  const usage = (providerJson as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  return {
    promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
    totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
  };
}

function extractMessageContent(providerJson: unknown): string | null {
  if (typeof providerJson !== 'object' || providerJson === null) return null;
  const choices = (providerJson as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  const content = (message as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' ? content : null;
}

export function getConfiguredModel(): string {
  return Deno.env.get('DEEPSEEK_MODEL') ?? DEFAULT_MODEL;
}

function getConfiguredMaxOutputTokens(): number {
  const raw = Deno.env.get('DEEPSEEK_MAX_OUTPUT_TOKENS');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS;
}

// Below Supabase's Edge Function platform wall-clock limit with real margin
// — a single extraction job can chain up to ~5 calls (extraction + up to 2
// rounds of audit+repair), so every individual call needs its own hard cap,
// not just an overall budget checked between jobs (see dispatch-import-work).
const REQUEST_TIMEOUT_MS = 60_000;

/** One HTTP round-trip to DeepSeek. Never throws — network/timeout failures and non-2xx statuses become DeepSeekCallFailure. */
export async function callDeepSeek(params: {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens?: number;
}): Promise<DeepSeekCallOutcome | DeepSeekCallFailure> {
  const model = getConfiguredModel();
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) return { ok: false, error: 'provider_not_configured', latencyMs: 0, model };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: params.maxOutputTokens ?? getConfiguredMaxOutputTokens(),
        response_format: { type: 'json_object' },
        // Verified directly against the API: deepseek-v4-flash/-pro default
        // to always thinking (emitting reasoning_content before the real
        // answer, at real latency/token cost — this is what made a single
        // extraction job take minutes). This explicit toggle disables it —
        // confirmed via a live test call that reasoning_content disappears
        // entirely and completion_tokens drops from 43 to 5 for the same
        // trivial prompt. Non-thinking mode is exactly what mechanical,
        // temperature-0 transcription needs.
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
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
      res.status === 402
        ? 'provider_insufficient_balance'
        : res.status === 401 || res.status === 403
          ? 'provider_auth_failed'
          : res.status === 429
            ? 'provider_rate_limited'
            : res.status >= 500
              ? 'provider_unavailable'
              : 'provider_error';
    return { ok: false, error: `${label}: deepseek http ${res.status}`, latencyMs, model };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'provider_bad_response', latencyMs, model };
  }

  const content = extractMessageContent(json);
  if (content == null || content.trim() === '') {
    return { ok: false, error: 'provider response missing message content', latencyMs, model };
  }

  return { ok: true, json, content, usage: extractUsage(json), latencyMs, model };
}

export function parseJsonContent(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false, error: 'model content was not valid JSON' };
  }
}
