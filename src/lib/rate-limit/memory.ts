import type { RateLimitStore } from "./types";

/**
 * In-memory fixed-window store. DEVELOPMENT/TEST ONLY: counters are per-process, so with several
 * instances (or serverless) each instance enforces its own limit. Production requires Redis.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly name = "memory";
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number) {
    const t = this.now();
    if (this.buckets.size > 50_000) this.sweep(t);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      this.buckets.set(key, { count: 1, resetAt: t + windowMs });
      return { count: 1, ttlMs: windowMs };
    }
    b.count++;
    return { count: b.count, ttlMs: b.resetAt - t };
  }

  private sweep(t: number) {
    for (const [k, v] of this.buckets) if (v.resetAt <= t) this.buckets.delete(k);
  }
}
