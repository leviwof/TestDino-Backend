/**
 * Dependency-light rate limiter.
 *
 * Enforces two independent constraints:
 *  - maxConcurrency: at most N tasks run at once.
 *  - minIntervalMs:  successive task *starts* are spaced at least this far apart.
 */

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RateLimiterOptions {
  /** Injectable sleep (for tests). Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (for tests). Defaults to Date.now. */
  now?: () => number;
}

export class RateLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private lastStart = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly maxConcurrency: number,
    private readonly minIntervalMs: number,
    options: RateLimiterOptions = {},
  ) {
    if (maxConcurrency < 1) {
      throw new Error("maxConcurrency must be >= 1");
    }
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
  }

  /** Run `fn` under the concurrency + interval constraints. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    // Reserve a concurrency slot (queue if all are taken).
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;

    // Space out starts by at least minIntervalMs.
    if (this.minIntervalMs > 0) {
      const wait = this.minIntervalMs - (this.now() - this.lastStart);
      if (wait > 0) {
        await this.sleep(wait);
      }
    }
    this.lastStart = this.now();
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
