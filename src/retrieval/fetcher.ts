import { validateFetchUrl } from "./urlSecurity.js";

/**
 * Minimal HTTP page fetcher. Validates the URL (SSRF guard) before fetching,
 * enforces a timeout and byte cap, and only accepts HTML content types.
 * Does NOT crawl, parse, or handle robots.txt.
 */

export type FetcherErrorCode =
  | "FETCH_TIMEOUT"
  | "FETCH_NETWORK_ERROR"
  | "FETCH_HTTP_ERROR"
  | "FETCH_UNSUPPORTED_CONTENT_TYPE"
  | "FETCH_TOO_LARGE";

export class FetcherError extends Error {
  constructor(
    public readonly code: FetcherErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FetcherError";
  }
}

export interface FetchPageResult {
  url: string;
  status: number;
  contentType: string;
  html: string;
}

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_USER_AGENT = "InterviewPrepKitBot/0.1 (+https://example.com/bot)";
const ACCEPTED_TYPES = ["text/html", "application/xhtml+xml"];
const MAX_REDIRECTS = 5;

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Read the body up to maxBytes, throwing FETCH_TOO_LARGE if exceeded. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FetcherError(
          "FETCH_TOO_LARGE",
          `Response exceeded ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

export async function fetchPage(
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchPageResult> {
  const timeoutMs = options.timeoutMs ?? envInt("FETCH_TIMEOUT_MS", 10_000);
  const maxBytes = options.maxBytes ?? envInt("FETCH_MAX_BYTES", 2_000_000);
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Follow redirects manually so EVERY hop is re-validated against the SSRF
    // guard, not just the final destination.
    let currentUrl = url;
    let res: Response;

    for (let hop = 0; ; hop++) {
      await validateFetchUrl(currentUrl);

      if (hop > MAX_REDIRECTS) {
        throw new FetcherError(
          "FETCH_HTTP_ERROR",
          `Too many redirects (>${MAX_REDIRECTS})`,
        );
      }

      try {
        res = await doFetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml",
          },
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          throw new FetcherError("FETCH_TIMEOUT", `Request timed out after ${timeoutMs}ms`);
        }
        throw new FetcherError("FETCH_NETWORK_ERROR", `Network error: ${(err as Error).message}`);
      }

      // Redirect: resolve Location against the current URL and loop (revalidates).
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          throw new FetcherError(
            "FETCH_HTTP_ERROR",
            `Redirect (${res.status}) with no Location header`,
            res.status,
          );
        }
        await res.body?.cancel().catch(() => {});
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      break;
    }

    const finalUrl = res.url && res.url.length > 0 ? res.url : currentUrl;

    if (!res.ok) {
      throw new FetcherError(
        "FETCH_HTTP_ERROR",
        `HTTP ${res.status} for ${finalUrl}`,
        res.status,
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    const baseType = contentType.split(";")[0].trim().toLowerCase();
    if (!ACCEPTED_TYPES.includes(baseType)) {
      await res.body?.cancel().catch(() => {});
      throw new FetcherError(
        "FETCH_UNSUPPORTED_CONTENT_TYPE",
        `Unsupported content type: ${contentType || "(none)"}`,
      );
    }

    // Reject oversized responses up front when the server declares a length,
    // before downloading the body at all.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new FetcherError(
        "FETCH_TOO_LARGE",
        `Declared Content-Length ${declared} exceeds ${maxBytes} bytes`,
      );
    }

    const html = await readBounded(res, maxBytes);
    return { url: finalUrl, status: res.status, contentType, html };
  } finally {
    clearTimeout(timer);
  }
}
