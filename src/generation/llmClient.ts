import { loadCliEnv } from "../config/env.js";
import { RateLimiter } from "./rateLimiter.js";
import { withRetry } from "./retry.js";

/**
 * Provider-independent LLM client.
 *
 *   generateJson<T>(prompt): Promise<T>
 *
 * Requests a single JSON object from the configured provider, applies rate
 * limiting + retry, and parses the response safely. Malformed JSON throws a
 * typed LlmJsonParseError — it is never silently returned.
 */

// ---- Typed errors ----

export class LlmError extends Error {}

/** Non-2xx response from the provider. Carries status + optional Retry-After. */
export class LlmHttpError extends LlmError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

/** The provider returned text that is not valid JSON. */
export class LlmJsonParseError extends LlmError {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "LlmJsonParseError";
  }
}

// ---- Types ----

export interface LlmRequest {
  prompt: string;
  provider: string;
  apiKey?: string;
  model: string;
  signal?: AbortSignal;
}

/** Performs one provider call. Returns the model's text; throws LlmHttpError on non-2xx. */
export type LlmTransport = (req: LlmRequest) => Promise<string>;

export interface LlmClientConfig {
  provider: string;
  apiKey?: string;
  model: string;
  maxConcurrency: number;
  minIntervalMs: number;
  maxAttempts?: number;
}

export interface LlmClientDeps {
  transport?: LlmTransport;
  rateLimiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface LlmClient {
  generateJson<T>(prompt: string): Promise<T>;
}

// ---- JSON parsing ----

/** Strip a surrounding ```json ... ``` (or bare ```) code fence, if present. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fence ? fence[1] : trimmed;
}

/** Parse LLM output as JSON, throwing LlmJsonParseError on failure. */
export function parseLlmJson<T>(raw: string): T {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new LlmJsonParseError(
      `LLM returned invalid JSON: ${(e as Error).message}`,
      raw,
    );
  }
}

// ---- Default HTTP transport (provider-specific request shaping) ----

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms. */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Extract a human-readable summary from a provider error body. OpenAI and
 * Anthropic both nest details under `error` ({ message, type, code }). Returns
 * `undefined` when the body is empty or not the expected JSON shape, so the
 * caller can fall back to a plain status message.
 */
export function summarizeErrorBody(body: string): string | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const err = (parsed as { error?: unknown } | null)?.error;
  if (!err || typeof err !== "object") return undefined;

  const { message, type, code } = err as {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
  const parts: string[] = [];
  if (typeof message === "string" && message) parts.push(message);
  const tags: string[] = [];
  if (typeof type === "string" && type) tags.push(`type: ${type}`);
  if ((typeof code === "string" || typeof code === "number") && code) tags.push(`code: ${code}`);
  if (tags.length > 0) parts.push(`(${tags.join(", ")})`);

  return parts.length > 0 ? parts.join(" ") : undefined;
}

const JSON_SYSTEM_PROMPT =
  "You are a precise assistant. Respond with a single valid JSON object and nothing else.";

/** Providers whose HTTP API requires an API key. */
const KEYED_PROVIDERS = new Set(["openai", "anthropic", "openrouter"]);

// ---- Mock provider (development / test only) ----

/** Extract requirement ids (r1, r2, …) rendered in a prompt. */
function extractRequirementIds(prompt: string): string[] {
  return [...new Set(prompt.match(/\br\d+\b/g) ?? [])];
}

/**
 * Deterministic, offline LLM stub used when LLM_PROVIDER="mock".
 *
 * DEVELOPMENT / TEST ONLY. It makes no network calls and needs no API key. It
 * dispatches on the stage marker embedded in each prompt and returns fixed JSON
 * that satisfies that stage's Zod schema, referencing the requirement ids that
 * appear in the prompt so questions/flashcards survive downstream filtering.
 *
 * The mock provider is refused in production (see defaultTransport).
 */
export const mockTransport: LlmTransport = async (req) => {
  const p = req.prompt.toUpperCase();
  const reqIds = extractRequirementIds(req.prompt);
  const firstId = reqIds[0];

  // Requirement extraction — no ids exist yet; return a small fixed role.
  if (p.includes("JOB DESCRIPTION:")) {
    return JSON.stringify({
      title: "Mock Role",
      seniority: "mid",
      responsibilities: [
        "Build and maintain core services",
        "Collaborate across teams",
      ],
      requirements: [
        {
          text: "Core technical competency for the role",
          kind: "technical",
          priority: "must",
        },
        {
          text: "Clear written and verbal communication",
          kind: "behavioural",
          priority: "nice",
        },
      ],
    });
  }

  // Company brief — cite only source URLs present in the prompt.
  if (p.includes("SOURCE MATERIAL:")) {
    const urls = [...req.prompt.matchAll(/<source url="([^"]+)">/g)].map(
      (m) => m[1],
    );
    return JSON.stringify({
      summary: "Mock company brief generated for local development.",
      what_they_do: "Builds software products for its customers.",
      sources: urls.slice(0, 2),
    });
  }

  // Flashcards — must reference at least one real requirement id.
  if (p.includes("FLASHCARDS")) {
    return JSON.stringify({
      flashcards: firstId
        ? [
            {
              requirement_ids: [firstId],
              front: "Mock flashcard front",
              back: "Mock flashcard back.",
            },
          ]
        : [],
    });
  }

  // Coverage-gap questions — this stage's schema includes a category field.
  if (p.includes("COVERAGE GAPS")) {
    return JSON.stringify({
      questions: firstId
        ? [
            {
              requirement_ids: [firstId],
              category: "technical",
              prompt: `Mock gap question covering ${firstId}`,
              answer_outline: "Key points an interviewer would look for.",
              difficulty: 2,
            },
          ]
        : [],
    });
  }

  // Category question generation (technical / behavioural / system-design /
  // company-fit) — all share one shape; the category is assigned by the caller.
  if (p.includes("INTERVIEW QUESTIONS")) {
    return JSON.stringify({
      questions: firstId
        ? [
            {
              requirement_ids: [firstId],
              prompt: `Mock interview question covering ${firstId}`,
              answer_outline: "Key points an interviewer would look for.",
              difficulty: 2,
            },
          ]
        : [],
    });
  }

  // Unknown stage: return an empty object; the caller's Zod schema will surface
  // the mismatch loudly rather than the mock silently faking unknown output.
  return "{}";
};

export const defaultTransport: LlmTransport = async (req) => {
  const { provider, apiKey, model, prompt, signal } = req;

  // Development/test-only offline stub. Never allowed in production so real
  // deployments cannot accidentally serve fabricated content.
  if (provider === "mock") {
    if ((process.env.NODE_ENV ?? "").toLowerCase() === "production") {
      throw new LlmError(
        'LLM_PROVIDER="mock" is a development/test-only stub and must not be ' +
          "used in production. Set LLM_PROVIDER to a real provider (openai/anthropic).",
      );
    }
    return mockTransport(req);
  }

  // Fail fast with an actionable message instead of sending an empty
  // Authorization header, which the provider rejects with an opaque HTTP 401.
  if (KEYED_PROVIDERS.has(provider) && !(apiKey && apiKey.length > 0)) {
    const keyEnvVar =
      provider === "openrouter" ? "OPENROUTER_API_KEY" : "LLM_API_KEY";
    throw new LlmError(
      `${keyEnvVar} is missing or empty for provider "${provider}". ` +
        `Set ${keyEnvVar} in the environment (see .env.example). ` +
        `Requests cannot be authenticated without it.`,
    );
  }

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "content-type": "application/json",
      "x-api-key": apiKey ?? "",
      "anthropic-version": "2023-06-01",
    };
    body = {
      model,
      max_tokens: 4096,
      system: JSON_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    };
  } else if (provider === "openrouter") {
    url = "https://openrouter.ai/api/v1/chat/completions";
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey ?? ""}`,
    };
    let openRouterModel = model;
    if (openRouterModel === "openai" || openRouterModel === "gpt-4o-mini") {
      openRouterModel = "openai/gpt-4o-mini";
    } else if (!openRouterModel.includes("/")) {
      openRouterModel = `openai/${openRouterModel}`;
    }
    body = {
      model: openRouterModel,
      messages: [
        { role: "system", content: JSON_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    };
  } else {
    // Default to an OpenAI-compatible chat completions endpoint.
    url = "https://api.openai.com/v1/chat/completions";
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey ?? ""}`,
    };
    body = {
      model,
      messages: [
        { role: "system", content: JSON_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = summarizeErrorBody(text);
    throw new LlmHttpError(
      `LLM request failed with HTTP ${res.status}` +
        (detail ? `: ${detail}` : ""),
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
      text,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  if (provider === "anthropic") {
    const content = data.content as Array<{ text?: string }> | undefined;
    return content?.[0]?.text ?? "";
  }
  const choices = data.choices as
    | Array<{ message?: { content?: string } }>
    | undefined;
  return choices?.[0]?.message?.content ?? "";
};

// ---- JSON repair ----

/**
 * Build the prompt for a single JSON-repair attempt. The model is asked to fix
 * only formatting, never to add or change the underlying content.
 */
export function buildRepairPrompt(
  originalPrompt: string,
  invalidResponse: string,
): string {
  return [
    "The response below was supposed to be a single valid JSON object but could not be parsed.",
    "Return valid JSON only — no markdown fences, no commentary, no explanation.",
    "Do not add any information that is not already present in the response.",
    "Preserve the original meaning exactly.",
    "Fix only JSON/schema formatting problems (quotes, commas, brackets, escaping, trailing text).",
    "",
    "Original request (for context only — do not answer it again):",
    originalPrompt,
    "",
    "Invalid response to repair:",
    invalidResponse,
  ].join("\n");
}

// ---- Client factory ----

export function createLlmClient(
  config: LlmClientConfig,
  deps: LlmClientDeps = {},
): LlmClient {
  const transport = deps.transport ?? defaultTransport;
  const limiter =
    deps.rateLimiter ??
    new RateLimiter(config.maxConcurrency, config.minIntervalMs);

  // One model call through the rate limiter + retry system.
  const callModel = (prompt: string): Promise<string> =>
    limiter.run(() =>
      withRetry(
        () =>
          transport({
            prompt,
            provider: config.provider,
            apiKey: config.apiKey,
            model: config.model,
          }),
        {
          maxAttempts: config.maxAttempts ?? 3,
          sleep: deps.sleep,
          random: deps.random,
        },
      ),
    );

  async function generateJson<T>(prompt: string): Promise<T> {
    const raw = await callModel(prompt);
    try {
      return parseLlmJson<T>(raw);
    } catch (err) {
      if (!(err instanceof LlmJsonParseError)) throw err;

      // Exactly one repair attempt (also rate-limited + retried).
      const repairedRaw = await callModel(buildRepairPrompt(prompt, raw));
      try {
        return parseLlmJson<T>(repairedRaw);
      } catch (repairErr) {
        if (repairErr instanceof LlmJsonParseError) {
          throw new LlmJsonParseError(
            `LLM returned invalid JSON and the single repair attempt also failed: ${repairErr.message}`,
            repairedRaw,
          );
        }
        throw repairErr;
      }
    }
  }

  return { generateJson };
}

// ---- Default env-backed client ----

/**
 * Safe, non-secret summary of the LLM configuration. Reports whether an API key
 * is present and its length — never the key itself.
 */
export interface LlmConfigReport {
  provider: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyLength: number;
}

export function describeLlmConfig(config: {
  provider: string;
  model: string;
  apiKey?: string;
}): LlmConfigReport {
  const key = config.apiKey ?? "";
  return {
    provider: config.provider,
    model: config.model,
    apiKeyConfigured: key.length > 0,
    apiKeyLength: key.length,
  };
}

/** Format the config report as safe multi-line text (no secrets). */
export function formatLlmConfigReport(report: LlmConfigReport): string {
  return [
    `LLM provider: ${report.provider}`,
    `LLM model: ${report.model}`,
    `API key configured: ${report.apiKeyConfigured}`,
    `API key length: ${report.apiKeyLength}`,
  ].join("\n");
}

let defaultClientInstance: LlmClient | undefined;

export function resetDefaultClient(): void {
  defaultClientInstance = undefined;
}

function getDefaultClient(): LlmClient {
  if (!defaultClientInstance) {
    const env = loadCliEnv();

    const apiKey =
      env.LLM_PROVIDER === "openrouter"
        ? (env.OPENROUTER_API_KEY || env.LLM_API_KEY)
        : env.LLM_API_KEY;

    // Safe startup diagnostic on stderr (keeps stdout clean for JSON output).
    // Never prints the key — only whether it exists and its length.
    const report = describeLlmConfig({
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL,
      apiKey,
    });
    console.error(formatLlmConfigReport(report));

    defaultClientInstance = createLlmClient({
      provider: env.LLM_PROVIDER,
      apiKey,
      model: env.LLM_MODEL,
      maxConcurrency: env.LLM_MAX_CONCURRENCY,
      minIntervalMs: env.LLM_MIN_INTERVAL_MS,
    });
  }
  return defaultClientInstance;
}

/** Convenience: request structured JSON using the env-configured client. */
export function generateJson<T>(prompt: string): Promise<T> {
  return getDefaultClient().generateJson<T>(prompt);
}
