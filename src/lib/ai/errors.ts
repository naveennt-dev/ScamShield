/**
 * Typed errors for LLM providers. The router uses `retryable` / `fallbackable` to decide whether
 * to retry the same model, move to the next model, or abort the chain.
 */

export type AIErrorCode =
  | "NOT_CONFIGURED"
  | "AUTH" // invalid/missing API key – no other model will work either
  | "TIMEOUT"
  | "NETWORK"
  | "RATE_LIMITED"
  | "PROVIDER_5XX"
  | "MODEL_UNAVAILABLE" // 404 / model removed / no endpoints for model
  | "BAD_REQUEST" // 400 / 422 (e.g. unsupported parameter for this model)
  | "INSUFFICIENT_CREDITS" // 402
  | "MALFORMED_RESPONSE" // not JSON / empty
  | "SCHEMA_INVALID" // JSON but fails Zod validation
  | "CIRCUIT_OPEN"
  | "BUDGET_EXHAUSTED";

const RETRYABLE: ReadonlySet<AIErrorCode> = new Set([
  "TIMEOUT",
  "NETWORK",
  "RATE_LIMITED",
  "PROVIDER_5XX",
  "MALFORMED_RESPONSE",
  "SCHEMA_INVALID",
]);

/** Errors after which trying a *different* model makes no sense. */
const CHAIN_FATAL: ReadonlySet<AIErrorCode> = new Set(["NOT_CONFIGURED", "AUTH", "INSUFFICIENT_CREDITS"]);

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly model?: string;

  constructor(
    code: AIErrorCode,
    message: string,
    opts: { status?: number; retryAfterMs?: number; model?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AIError";
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.model = opts.model;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get chainFatal(): boolean {
    return CHAIN_FATAL.has(this.code);
  }
}

export function classifyHttpStatus(status: number): AIErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return "INSUFFICIENT_CREDITS";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_5XX";
  return "BAD_REQUEST";
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
