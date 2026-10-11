import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import { MemoryRateLimitStore } from "./memory";
import { RedisRateLimitStore } from "./redis";
import type { RateLimitResult, RateLimitScope, RateLimitStore, RateLimitTier, WindowLimit } from "./types";

export type { RateLimitScope, RateLimitTier } from "./types";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * Per-scope limits per tier. Every request must pass ALL windows for its scope.
 * "local" (Phase 6) is the personal Mac app on a loopback-only service: generous enough for real
 * daily use (the anonymous 30/day cap made the app stop working after 30 scans) but still bounded
 * so a runaway client can't hammer the service. It never applies to reports.
 */
export const POLICIES: Record<RateLimitScope, Record<RateLimitTier, WindowLimit[]>> = {
  analyze_message: {
    anonymous: [{ limit: 5, windowMs: MIN }, { limit: 30, windowMs: DAY }],
    local: [{ limit: 60, windowMs: MIN }, { limit: 2000, windowMs: DAY }],
    authenticated: [{ limit: 20, windowMs: MIN }, { limit: 500, windowMs: DAY }],
    premium: [{ limit: 60, windowMs: MIN }, { limit: 5000, windowMs: DAY }],
  },
  analyze_url: {
    anonymous: [{ limit: 5, windowMs: MIN }, { limit: 30, windowMs: DAY }],
    local: [{ limit: 60, windowMs: MIN }, { limit: 2000, windowMs: DAY }],
    authenticated: [{ limit: 20, windowMs: MIN }, { limit: 500, windowMs: DAY }],
    premium: [{ limit: 60, windowMs: MIN }, { limit: 5000, windowMs: DAY }],
  },
  analyze_image: {
    anonymous: [{ limit: 2, windowMs: MIN }, { limit: 10, windowMs: DAY }],
    local: [{ limit: 20, windowMs: MIN }, { limit: 500, windowMs: DAY }],
    authenticated: [{ limit: 5, windowMs: MIN }, { limit: 100, windowMs: DAY }],
    premium: [{ limit: 20, windowMs: MIN }, { limit: 1000, windowMs: DAY }],
  },
  analyze_email: {
    anonymous: [{ limit: 3, windowMs: MIN }, { limit: 20, windowMs: DAY }],
    local: [{ limit: 30, windowMs: MIN }, { limit: 1000, windowMs: DAY }],
    authenticated: [{ limit: 10, windowMs: MIN }, { limit: 200, windowMs: DAY }],
    premium: [{ limit: 40, windowMs: MIN }, { limit: 2000, windowMs: DAY }],
  },
  report: {
    anonymous: [{ limit: 0, windowMs: MIN }],
    local: [{ limit: 0, windowMs: MIN }],
    authenticated: [{ limit: 10, windowMs: MIN }, { limit: 100, windowMs: DAY }],
    premium: [{ limit: 30, windowMs: MIN }, { limit: 500, windowMs: DAY }],
  },
  read: {
    anonymous: [{ limit: 30, windowMs: MIN }],
    local: [{ limit: 120, windowMs: MIN }],
    authenticated: [{ limit: 120, windowMs: MIN }],
    premium: [{ limit: 300, windowMs: MIN }],
  },
  // Isolated-browser page inspections (expensive; run untrusted pages): far tighter than scans.
  inspect: {
    anonymous: [{ limit: 2, windowMs: MIN }, { limit: 10, windowMs: DAY }],
    local: [{ limit: 6, windowMs: MIN }, { limit: 100, windowMs: DAY }],
    authenticated: [{ limit: 3, windowMs: MIN }, { limit: 30, windowMs: DAY }],
    premium: [{ limit: 6, windowMs: MIN }, { limit: 100, windowMs: DAY }],
  },
  // Opt-in learning contributions: small daily budgets limit how much one installation can push.
  contribute: {
    anonymous: [{ limit: 3, windowMs: MIN }, { limit: 30, windowMs: DAY }],
    local: [{ limit: 30, windowMs: MIN }, { limit: 300, windowMs: DAY }],
    authenticated: [{ limit: 5, windowMs: MIN }, { limit: 60, windowMs: DAY }],
    premium: [{ limit: 10, windowMs: MIN }, { limit: 120, windowMs: DAY }],
  },
  write: {
    anonymous: [{ limit: 10, windowMs: MIN }],
    local: [{ limit: 30, windowMs: MIN }],
    authenticated: [{ limit: 30, windowMs: MIN }],
    premium: [{ limit: 60, windowMs: MIN }],
  },
};

let store: RateLimitStore | null = null;
let fallback: MemoryRateLimitStore | null = null;
let warned = false;

export function getRateLimitStore(): RateLimitStore {
  if (store) return store;
  const env = getEnv();
  if (env.REDIS_URL) {
    store = new RedisRateLimitStore(env.REDIS_URL);
  } else {
    if (env.NODE_ENV === "production" && !warned) {
      warned = true;
      logger.error("rate_limit_memory_store_in_production", {
        message: "REDIS_URL is not set: rate limits are per-instance only. Configure Redis for production.",
      });
    }
    store = new MemoryRateLimitStore();
  }
  return store;
}

export function setRateLimitStore(s: RateLimitStore | null): void {
  store = s;
}

export async function checkRateLimit(scope: RateLimitScope, tier: RateLimitTier, identity: string): Promise<RateLimitResult> {
  const env = getEnv();
  const windows = POLICIES[scope][tier];
  if (!env.RATE_LIMIT_ENABLED) {
    return { allowed: true, limit: windows[0].limit, remaining: windows[0].limit, resetMs: 0 };
  }
  let tightest: RateLimitResult | null = null;
  for (const w of windows) {
    const key = `${scope}:${tier}:${w.windowMs}:${identity}`;
    let hit: { count: number; ttlMs: number };
    try {
      hit = await getRateLimitStore().hit(key, w.windowMs);
    } catch (error) {
      // Redis outage: degrade to a per-instance limiter rather than failing open completely.
      logger.warn("rate_limit_store_error", { error, scope });
      fallback ??= new MemoryRateLimitStore();
      hit = await fallback.hit(key, w.windowMs);
    }
    const res: RateLimitResult = {
      allowed: hit.count <= w.limit,
      limit: w.limit,
      remaining: Math.max(0, w.limit - hit.count),
      resetMs: hit.ttlMs,
    };
    if (!res.allowed) {
      metrics.rateLimited(scope, tier);
      return res;
    }
    if (!tightest || res.remaining < tightest.remaining) tightest = res;
  }
  return tightest!;
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(r.limit),
    "X-RateLimit-Remaining": String(r.remaining),
    "X-RateLimit-Reset": String(Math.ceil(r.resetMs / 1000)),
  };
  if (!r.allowed) h["Retry-After"] = String(Math.max(1, Math.ceil(r.resetMs / 1000)));
  return h;
}
