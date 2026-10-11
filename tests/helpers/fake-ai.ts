import type { AIProvider } from "@/lib/ai/provider";
import { AIError } from "@/lib/ai/errors";
import type { LLMScamResponse, ScamAIInput, ScamAIResult } from "@/lib/ai/schemas";

export function fakeAI(response: Partial<LLMScamResponse> & { usedFallback?: boolean; model?: string }): AIProvider & { calls: ScamAIInput[] } {
  const calls: ScamAIInput[] = [];
  return {
    name: "fake",
    available: true,
    calls,
    async analyzeScam(input): Promise<ScamAIResult> {
      calls.push(input);
      const analysis: LLMScamResponse = {
        classification: "safe",
        category: "other",
        riskScore: 5,
        confidence: 0.9,
        indicators: [],
        suspiciousEntities: [],
        recommendedActions: [],
        explanation: "Looks fine.",
        ...response,
      };
      return {
        analysis,
        classification: analysis.classification,
        modelMetadata: { provider: "fake", model: response.model ?? "fake/model" },
        attempts: response.usedFallback ? 2 : 1,
        usedFallback: Boolean(response.usedFallback),
        latencyMs: 1,
      };
    },
  };
}

export function failingAI(code: AIError["code"] = "PROVIDER_5XX"): AIProvider {
  return {
    name: "fake",
    available: true,
    async analyzeScam() {
      throw new AIError(code, "simulated failure");
    },
  };
}
