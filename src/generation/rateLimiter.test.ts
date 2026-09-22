import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rateLimiter.js";

/** A promise you can resolve from the outside. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let queued microtasks/timers settle. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("RateLimiter", () => {
  it("never exceeds the configured concurrency", async () => {
    const limiter = new RateLimiter(2, 0);
    const gate = deferred();

    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
      }),
    );

    await flush();
    // Only 2 tasks should be running while the gate is closed.
    expect(active).toBe(2);

    gate.resolve();
    await Promise.all(tasks);

    expect(maxActive).toBe(2);
  });
});
