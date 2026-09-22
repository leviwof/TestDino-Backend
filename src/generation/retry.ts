/**
 * Provider-independent retry with exponential backoff + jitter.
 *
 * Retries only transient failures (HTTP 429 and 5xx by default) and honours a
 * provider-supplied Retry-After (surfaced as `err.retryAfterMs`). Permanent
 * errors (other 4xx, validation, JSON parse) are not retried.
 *
 * The retry predicate is duck-typed on `err.status` / `err.retryAfterMs` so this
 * module has no dependency on the LLM client (avoids a circular import).
 */

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default: retry HTTP 429 and any 5xx. */
export function defaultIsRetryable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

/** Default: use `err.retryAfterMs` when the provider supplied it. */
export function defaultGetRetryAfterMs(err: unknown): number | undefined {
  const ms = (err as { retryAfterMs?: number } | null)?.retryAfterMs;
  return typeof ms === "number" && ms >= 0 ? ms : undefined;
}

export interface RetryOptions {
  /** Maximum attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Base backoff delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Cap on computed backoff (before Retry-After) in ms. Default 20000. */
  maxDelayMs?: number;
  /** Whether an error is transient/retryable. */
  isRetryable?: (err: unknown) => boolean;
  /** Extract an explicit Retry-After delay (ms) from the error. */
  getRetryAfterMs?: (err: unknown) => number | undefined;
  /** Injectable sleep (for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0,1) for jitter (for tests). */
  random?: () => number;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * Rethrows the final error if all attempts are exhausted or the error is
 * non-retryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 20_000;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const getRetryAfterMs = options.getRetryAfterMs ?? defaultGetRetryAfterMs;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }

      const retryAfter = getRetryAfterMs(err);
      let delay: number;
      if (retryAfter !== undefined) {
        delay = retryAfter;
      } else {
        // Equal jitter: half fixed, half random, capped at maxDelayMs.
        const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        delay = exp / 2 + random() * (exp / 2);
      }
      await sleep(delay);
    }
  }
}
