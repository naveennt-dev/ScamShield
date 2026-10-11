import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import { AIError, type AIErrorCode } from "./errors";
import type { ChatMessage, OpenRouterClient } from "./openrouter";

/**
 * Model router: primary → fallback (→ fast) with bounded retries, exponential backoff with
 * jitter, Retry-After handling, a total time budget, JSON-mode downgrade and a per-model circuit
 * breaker. If every model fails, it throws `RouterExhaustedError` and the caller falls back to the
 * deterministic pipeline. It never retries endlessly: total attempts are bounded by
 * models × (maxRetries + 1) and by the total budget.
 */

export interface ModelRouterConfig {
  primaryModel?: string;
  fallbackModel?: string;
  fastModel?: string;
  timeoutMs: number;
  maxRetries: number;
  totalBudgetMs: number;
  maxTokens: number;
  /** Longest Retry-After we are willing to wait before moving to the next model. */
  maxRetryAfterWaitMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
}

export interface RouteAttemptError {
  model: string;
  code: AIErrorCode;
  status?: number;
}

export interface RoutedResult<T> {
  value: T;
  model: string;
  attempts: number;
  usedFallback: boolean;
  latencyMs: number;
  errors: RouteAttemptError[];
}

export class RouterExhaustedError extends AIError {
  readonly errors: RouteAttemptError[];
  readonly attempts: number;
  constructor(code: AIErrorCode, errors: RouteAttemptError[], attempts: number) {
    super(code, `All models failed (${errors.map((e) => `${e.model}:${e.code}`).join(", ") || code})`);
    this.name = "RouterExhaustedError";
    this.errors = errors;
    this.attempts = attempts;
  }
}

interface BreakerState {
  failures: number;
  openUntil: number;
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ModelRouter {
  private readonly breakers = new Map<string, BreakerState>();
  private readonly cfg: Required<Omit<ModelRouterConfig, "primaryModel" | "fallbackModel" | "fastModel">> &
    Pick<ModelRouterConfig, "primaryModel" | "fallbackModel" | "fastModel">;

  constructor(
    private readonly client: Pick<OpenRouterClient, "chat" | "configured">,
    cfg: ModelRouterConfig,
    private readonly sleep: Sleep = realSleep,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {
    this.cfg = {
      maxRetryAfterWaitMs: 5000,
      baseBackoffMs: 400,
      maxBackoffMs: 4000,
      breakerThreshold: 3,
      breakerCooldownMs: 60_000,
      ...cfg,
    };
  }

  /** Ordered, de-duplicated list of models for a tier. Empty entries are ignored. */
  chain(tier: "standard" | "fast" = "standard"): string[] {
    const { primaryModel, fallbackModel, fastModel } = this.cfg;
    const ordered = tier === "fast" ? [fastModel, primaryModel, fallbackModel] : [primaryModel, fallbackModel, fastModel];
    return [...new Set(ordered.filter((m): m is string => Boolean(m && m.trim())).map((m) => m.trim()))];
  }

  get available(): boolean {
    return this.client.configured && this.chain().length > 0;
  }

  async run<T>(opts: {
    messages: ChatMessage[];
    parse: (content: string) => T;
    requestId: string;
    tier?: "standard" | "fast";
    /** Restrict the chain to these models (e.g. the ones that passed the free-model check). */
    models?: string[];
  }): Promise<RoutedResult<T>> {
    const log = logger.child({ requestId: opts.requestId, component: "model-router" });
    if (!this.client.configured) throw new RouterExhaustedError("NOT_CONFIGURED", [], 0);
    const models = opts.models ? this.chain(opts.tier).filter((m) => opts.models!.includes(m)) : this.chain(opts.tier);
    if (models.length === 0) throw new RouterExhaustedError(opts.models ? "MODEL_UNAVAILABLE" : "NOT_CONFIGURED", [], 0);

    const started = this.now();
    const deadline = started + this.cfg.totalBudgetMs;
    const errors: RouteAttemptError[] = [];
    let attempts = 0;

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      if (this.isOpen(model)) {
        errors.push({ model, code: "CIRCUIT_OPEN" });
        metrics.llmCall(model, "circuit_open");
        continue;
      }

      let jsonMode = true;
      for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
        const remaining = deadline - this.now();
        if (remaining < 500) {
          errors.push({ model, code: "BUDGET_EXHAUSTED" });
          throw this.exhausted(errors, attempts, log);
        }
        attempts++;
        try {
          const res = await this.client.chat({
            model,
            messages: opts.messages,
            timeoutMs: Math.min(this.cfg.timeoutMs, remaining),
            maxTokens: this.cfg.maxTokens,
            jsonMode,
            requestId: opts.requestId,
          });
          const value = opts.parse(res.content); // throws AIError on malformed/invalid output
          this.recordSuccess(model);
          metrics.llmCall(model, "ok");
          metrics.llmLatency(model, res.latencyMs);
          if (mi > 0) metrics.llmFallback("next_model");
          log.info("llm_success", { model: res.model, attempts, latencyMs: res.latencyMs, fallbackIndex: mi });
          return {
            value,
            model: res.model,
            attempts,
            usedFallback: mi > 0,
            latencyMs: this.now() - started,
            errors,
          };
        } catch (err) {
          const e =
            err instanceof AIError ? err : new AIError("MALFORMED_RESPONSE", "Unexpected parse failure", { cause: err });
          errors.push({ model, code: e.code, status: e.status });
          metrics.llmCall(model, e.code.toLowerCase());
          log.warn("llm_attempt_failed", { model, attempt, code: e.code, status: e.status });

          if (e.chainFatal) throw this.exhausted(errors, attempts, log, e.code);

          // Some free models reject response_format; retry once without JSON mode (free retry).
          if (e.code === "BAD_REQUEST" && jsonMode) {
            jsonMode = false;
            attempt--;
            continue;
          }

          if (!e.retryable) {
            this.recordFailure(model);
            break; // next model
          }

          if (attempt >= this.cfg.maxRetries) {
            this.recordFailure(model);
            break;
          }

          // Long Retry-After on a (shared) free-tier limit: don't wait, try the next model.
          if (e.code === "RATE_LIMITED" && (e.retryAfterMs ?? 0) > this.cfg.maxRetryAfterWaitMs) break;

          const backoff =
            e.retryAfterMs ??
            Math.min(this.cfg.maxBackoffMs, this.cfg.baseBackoffMs * 2 ** attempt) * (0.5 + this.random() * 0.5);
          if (this.now() + backoff >= deadline - 500) {
            errors.push({ model, code: "BUDGET_EXHAUSTED" });
            throw this.exhausted(errors, attempts, log);
          }
          await this.sleep(backoff);
        }
      }
    }
    throw this.exhausted(errors, attempts, log);
  }

  private exhausted(
    errors: RouteAttemptError[],
    attempts: number,
    log: ReturnType<typeof logger.child>,
    code?: AIErrorCode,
  ): RouterExhaustedError {
    const finalCode = code ?? errors[errors.length - 1]?.code ?? "PROVIDER_5XX";
    metrics.llmFallback("deterministic");
    log.warn("llm_chain_exhausted", { attempts, code: finalCode, errors });
    return new RouterExhaustedError(finalCode, errors, attempts);
  }

  private isOpen(model: string): boolean {
    const b = this.breakers.get(model);
    return Boolean(b && b.openUntil > this.now());
  }

  private recordFailure(model: string) {
    const b = this.breakers.get(model) ?? { failures: 0, openUntil: 0 };
    b.failures++;
    if (b.failures >= this.cfg.breakerThreshold) {
      b.openUntil = this.now() + this.cfg.breakerCooldownMs;
      b.failures = 0;
    }
    this.breakers.set(model, b);
  }

  private recordSuccess(model: string) {
    this.breakers.delete(model);
  }
}
