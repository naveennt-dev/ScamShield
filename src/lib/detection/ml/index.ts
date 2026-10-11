import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import { loadEmbeddedClassifier, type MlPrediction } from "./classifier";
import { MlServiceClient, MlServiceError } from "./service-client";

/**
 * ML backend selection (ML_BACKEND):
 *   service  – local Python service only (joblib model)
 *   embedded – in-process TypeScript evaluation of the portable JSON model
 *   auto     – service first; on failure fall back to embedded (default)
 * After a service failure, the service is skipped for SERVICE_COOLDOWN_MS so a stopped service
 * doesn't add a timeout to every scan.
 */

export interface MlOutcome {
  prediction: MlPrediction | null;
  note?: string;
}

const SERVICE_COOLDOWN_MS = 30_000;
let serviceDownUntil = 0;

export interface MlEngine {
  predict(text: string, requestId?: string): Promise<MlOutcome>;
}

export function createMlEngine(deps: { service?: MlServiceClient | null; embedded?: () => Promise<{ predict(t: string): Promise<MlPrediction> } | null> } = {}): MlEngine {
  const env = getEnv();
  const mode = env.ML_BACKEND;
  const service = deps.service === undefined ? new MlServiceClient(env.ML_SERVICE_URL, env.ML_SERVICE_TIMEOUT_MS) : deps.service;
  const embedded = deps.embedded ?? (() => loadEmbeddedClassifier(env.ML_MODEL_PATH));

  return {
    async predict(text, requestId) {
      let serviceNote: string | undefined;
      if (mode !== "embedded" && service && Date.now() >= serviceDownUntil) {
        const t0 = Date.now();
        try {
          const p = await service.predict(text, requestId);
          metrics.mlLatency(Date.now() - t0);
          return { prediction: p };
        } catch (e) {
          const code = e instanceof MlServiceError ? e.code : "UNKNOWN";
          serviceDownUntil = Date.now() + SERVICE_COOLDOWN_MS;
          metrics.mlFailure(`service_${code.toLowerCase()}`);
          logger.warn("ml_service_failed", { requestId, code });
          serviceNote = `ML service ${code.toLowerCase()}`;
          if (mode === "service") return { prediction: null, note: serviceNote };
        }
      } else if (mode === "service") {
        return { prediction: null, note: "ML service unavailable (cooling down)" };
      }
      const model = await embedded();
      if (!model) return { prediction: null, note: serviceNote ? `${serviceNote}; embedded model missing` : "embedded model missing" };
      const t0 = Date.now();
      const p = await model.predict(text);
      metrics.mlLatency(Date.now() - t0);
      return { prediction: p, note: serviceNote ? `${serviceNote}; used embedded model` : undefined };
    },
  };
}

export function resetMlServiceCooldown(): void {
  serviceDownUntil = 0;
}
