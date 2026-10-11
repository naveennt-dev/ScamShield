import { z } from "zod";
import { toPrediction, type MlPrediction } from "./classifier";

/**
 * Client for the local Python ML service (ml/inference/service.py). Only loopback URLs are
 * accepted (validated in config). The response is validated with Zod; anything unexpected is an
 * error — model output is never trusted blindly.
 */

const ServiceResponse = z.object({
  classification: z.enum(["safe", "suspicious", "scam"]),
  probability: z.number().min(0).max(1),
  probabilities: z.record(z.number().min(0).max(1)),
  category: z.string().nullable(),
  categoryProbability: z.number().min(0).max(1).nullable(),
  knownFeatures: z.number().int().nonnegative(),
  model: z.object({ name: z.string(), version: z.string(), buildId: z.string(), trainingKind: z.string() }),
  processingTimeMs: z.number().nonnegative(),
});

export type MlServiceErrorCode = "UNAVAILABLE" | "TIMEOUT" | "REJECTED" | "BAD_RESPONSE";

export class MlServiceError extends Error {
  constructor(readonly code: MlServiceErrorCode, message: string) {
    super(message);
    this.name = "MlServiceError";
  }
}

export class MlServiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async predict(text: string, requestId?: string): Promise<MlPrediction> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/predict`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Correlates the Mac scan → API → ML service logs (id only; never text).
          ...(requestId && /^[\w.-]{1,80}$/.test(requestId) ? { "X-Request-Id": requestId } : {}),
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      throw controller.signal.aborted
        ? new MlServiceError("TIMEOUT", `ML service exceeded ${this.timeoutMs}ms`)
        : new MlServiceError("UNAVAILABLE", "ML service unreachable");
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MlServiceError("BAD_RESPONSE", "ML service returned non-JSON");
    }
    if (!res.ok) throw new MlServiceError(res.status === 503 ? "UNAVAILABLE" : "REJECTED", `ML service HTTP ${res.status}`);
    const parsed = ServiceResponse.safeParse(body);
    if (!parsed.success) throw new MlServiceError("BAD_RESPONSE", "ML service response failed validation");
    const r = parsed.data;
    const sum = Object.values(r.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-3 || !(r.classification in r.probabilities)) {
      throw new MlServiceError("BAD_RESPONSE", "ML service probabilities are inconsistent");
    }
    const categoryProba = r.category && r.categoryProbability !== null ? { [r.category]: r.categoryProbability } : null;
    return toPrediction(
      r.probabilities,
      categoryProba,
      r.knownFeatures,
      { name: r.model.name, version: r.model.version, buildId: r.model.buildId },
      "service",
      r.model.trainingKind === "synthetic",
    );
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
