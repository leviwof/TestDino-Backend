import { describe, it, expect, beforeEach } from "vitest";
import { fetchPage } from "./fetcher.js";

beforeEach(() => {
  // Public host by default so validateFetchUrl passes; individual tests fetch example.com.
  process.env.ALLOW_PRIVATE_HOSTS = "false";
});

/** Build a minimal Response-like object with a controllable final URL + body. */
function makeResponse(opts: {
  status?: number;
  contentType?: string;
  body?: string;
  url?: string;
  location?: string;
  contentLength?: number;
}): Response {
  const status = opts.status ?? 200;
  const bodyText = opts.body ?? "";
  const headers = new Headers();
  if (opts.contentType) headers.set("content-type", opts.contentType);
  if (opts.location) headers.set("location", opts.location);
  if (opts.contentLength !== undefined) {
    headers.set("content-length", String(opts.contentLength));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bodyText) controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });

  return {
    ok: status >= 200 && status < 300,
    status,
    url: opts.url ?? "",
    headers,
    body: stream,
  } as unknown as Response;
}

describe("fetchPage", () => {
  it("returns parsed result for a valid HTML page", async () => {
    const fetchImpl = (async () =>
      makeResponse({
        contentType: "text/html; charset=utf-8",
        body: "<html><body>hi</body></html>",
      })) as unknown as typeof fetch;

    const result = await fetchPage("https://example.com/page", { fetchImpl });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/html");
    expect(result.html).toContain("<body>hi</body>");
    expect(result.url).toBe("https://example.com/page");
  });

  it("rejects unsupported content types", async () => {
    const fetchImpl = (async () =>
      makeResponse({ contentType: "application/json", body: "{}" })) as unknown as typeof fetch;

    await expect(
      fetchPage("https://example.com/data", { fetchImpl }),
    ).rejects.toMatchObject({ code: "FETCH_UNSUPPORTED_CONTENT_TYPE" });
  });

  it("throws on HTTP error status", async () => {
    const fetchImpl = (async () =>
      makeResponse({ status: 500, contentType: "text/html", body: "err" })) as unknown as typeof fetch;

    await expect(
      fetchPage("https://example.com/oops", { fetchImpl }),
    ).rejects.toMatchObject({ code: "FETCH_HTTP_ERROR", status: 500 });
  });

  it("throws when the body exceeds maxBytes", async () => {
    const big = "x".repeat(5000);
    const fetchImpl = (async () =>
      makeResponse({ contentType: "text/html", body: big })) as unknown as typeof fetch;

    await expect(
      fetchPage("https://example.com/big", { fetchImpl, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("re-validates each redirect hop and blocks private targets", async () => {
    // First response is a 302 pointing at a cloud metadata endpoint; the fetcher
    // must validate the redirect target before following it.
    const fetchImpl = (async (target: string) => {
      if (target === "https://example.com/redirect") {
        return makeResponse({
          status: 302,
          location: "http://169.254.169.254/latest/meta-data",
        });
      }
      return makeResponse({ contentType: "text/html", body: "secret" });
    }) as unknown as typeof fetch;

    await expect(
      fetchPage("https://example.com/redirect", { fetchImpl }),
    ).rejects.toMatchObject({ code: "FETCH_PRIVATE_HOST_BLOCKED" });
  });

  it("rejects oversized responses via Content-Length before downloading", async () => {
    const fetchImpl = (async () =>
      makeResponse({
        contentType: "text/html",
        contentLength: 999_999,
        body: "small body but big declared length",
      })) as unknown as typeof fetch;

    await expect(
      fetchPage("https://example.com/huge", { fetchImpl, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("throws FETCH_NETWORK_ERROR on connection failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      fetchPage("https://example.com/down", { fetchImpl }),
    ).rejects.toMatchObject({ code: "FETCH_NETWORK_ERROR" });
  });

  it("maps timeouts to FETCH_TIMEOUT", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof fetch;

    await expect(
      fetchPage("https://example.com/slow", { fetchImpl, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "FETCH_TIMEOUT" });
  });
});
