import { describe, it, expect, vi } from "vitest";
import { withRetry } from "./retry.js";

class HttpErr extends Error {
  constructor(
    public status: number,
    public retryAfterMs?: number,
  ) {
    super(`HTTP ${status}`);
  }
}

// Deterministic deps: no real waiting, fixed jitter.
const noSleep = vi.fn(async () => {});
const fixedRandom = () => 0.5;

describe("withRetry", () => {
  it("retries transient HTTP 429 then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpErr(429))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      sleep: noSleep,
      random: fixedRandom,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries HTTP 500 then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpErr(500))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      sleep: noSleep,
      random: fixedRandom,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After from the error", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpErr(429, 1234))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, { sleep, random: fixedRandom });

    expect(sleep).toHaveBeenCalledTimes(1);
    // Retry-After overrides computed backoff exactly.
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it("does not retry permanent 4xx errors", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpErr(400));

    await expect(
      withRetry(fn, { sleep: noSleep, random: fixedRandom }),
    ).rejects.toBeInstanceOf(HttpErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpErr(503));

    await expect(
      withRetry(fn, { sleep: noSleep, random: fixedRandom }),
    ).rejects.toBeInstanceOf(HttpErr);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
