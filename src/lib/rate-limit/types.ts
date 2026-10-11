export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

/** Fixed-window counter store. Implementations: Redis (production) and in-memory (dev/test). */
export interface RateLimitStore {
  readonly name: string;
  /** Increments `key` in a window of `windowMs`; returns the new count and ms until reset. */
  hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
}

export type RateLimitScope =
  | "analyze_message"
  | "analyze_url"
  | "analyze_image"
  | "analyze_email"
  | "report"
  | "read"
  | "write"
  | "contribute"
  | "inspect";

/** "local": the personal Mac app talking to a loopback-only ScamShield service (opt-in; see handler). */
export type RateLimitTier = "anonymous" | "local" | "authenticated" | "premium";

export interface WindowLimit {
  limit: number;
  windowMs: number;
}
