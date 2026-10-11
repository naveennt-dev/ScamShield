import { getEnv } from "@/lib/config/env";
import { FreeModelGuard, type FreeModelCheck } from "./free-models";
import { ModelRouter, RouterExhaustedError } from "./model-router";
import { OpenRouterClient } from "./openrouter";
import { buildScamPrompt } from "./prompts";
import { parseLLMScamResponse, type ScamAIInput, type ScamAIResult } from "./schemas";

/**
 * Provider abstraction. Business logic depends only on `AIProvider`; swapping OpenRouter for
 * another vendor means adding a new implementation here, not touching the pipeline.
 */
export interface AIProvider {
  readonly name: string;
  /** True when credentials and at least one model are configured. */
  readonly available: boolean;
  analyzeScam(input: ScamAIInput): Promise<ScamAIResult>;
}

export class OpenRouterScamProvider implements AIProvider {
  readonly name = "openrouter";
  /** Diagnostics of the most recent free-model check (model ids + reasons; no content/credentials). */
  lastModelCheck: FreeModelCheck | null = null;

  /** `freeModels` null = free-model policy off (OPENROUTER_REQUIRE_FREE_MODELS=false). */
  constructor(
    private readonly router: ModelRouter,
    private readonly freeModels: FreeModelGuard | null = null,
  ) {}

  /** Key present and at least one configured model that can pass the free-model policy. */
  get available(): boolean {
    if (!this.router.available) return false;
    return this.freeModels === null || this.router.chain().some((m) => FreeModelGuard.isFreeVariant(m));
  }

  async analyzeScam(input: ScamAIInput): Promise<ScamAIResult> {
    let models: string[] | undefined;
    if (this.freeModels) {
      const check = await this.freeModels.check(this.router.chain(input.tier));
      this.lastModelCheck = check;
      if (check.usable.length === 0) {
        const offline = check.rejected.some((r) => r.reason === "catalogue_unavailable");
        throw new RouterExhaustedError(
          offline ? "NETWORK" : "MODEL_UNAVAILABLE",
          check.rejected.map((r) => ({ model: r.model, code: offline ? ("NETWORK" as const) : ("MODEL_UNAVAILABLE" as const) })),
          0,
        );
      }
      models = check.usable;
    }
    const prompt = buildScamPrompt(input);
    const routed = await this.router.run({
      requestId: input.requestId,
      tier: input.tier,
      models,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      parse: parseLLMScamResponse,
    });
    return {
      analysis: routed.value,
      classification: routed.value.classification,
      modelMetadata: { provider: this.name, model: routed.model },
      attempts: routed.attempts,
      usedFallback: routed.usedFallback,
      latencyMs: routed.latencyMs,
    };
  }
}

let singleton: AIProvider | null = null;

export function getAIProvider(): AIProvider {
  if (singleton) return singleton;
  const env = getEnv();
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    appUrl: env.APP_URL ?? env.BETTER_AUTH_URL,
    appName: "ScamShield",
  });
  const router = new ModelRouter(client, {
    primaryModel: env.SCAM_PRIMARY_MODEL,
    fallbackModel: env.SCAM_FALLBACK_MODEL,
    fastModel: env.SCAM_FAST_MODEL,
    timeoutMs: env.OPENROUTER_TIMEOUT_MS,
    maxRetries: env.OPENROUTER_MAX_RETRIES,
    totalBudgetMs: env.OPENROUTER_TOTAL_BUDGET_MS,
    maxTokens: env.OPENROUTER_MAX_TOKENS,
  });
  const freeModels = env.OPENROUTER_REQUIRE_FREE_MODELS
    ? new FreeModelGuard({ baseUrl: env.OPENROUTER_BASE_URL, requireFree: true })
    : null;
  singleton = new OpenRouterScamProvider(router, freeModels);
  return singleton;
}

/** Test hook. */
export function setAIProvider(p: AIProvider | null): void {
  singleton = p;
}
