import { NextResponse } from "next/server";
import { getEnv } from "@/lib/config/env";
import { prisma, isDatabaseConfigured } from "@/lib/db/prisma";
import { getAIProvider } from "@/lib/ai/provider";
import { loadEmbeddedClassifier } from "@/lib/detection/ml/classifier";
import { MlServiceClient } from "@/lib/detection/ml/service-client";
import { getOcrProvider } from "@/lib/ocr/provider";
import { getRateLimitStore } from "@/lib/rate-limit";
import { RedisRateLimitStore } from "@/lib/rate-limit/redis";
import { API_VERSION } from "@/lib/api/response";
import { requestIdFrom } from "@/lib/api/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check = "ok" | "degraded" | "down" | "disabled" | "not_configured" | "opt_in";

/**
 * Liveness/readiness. Never calls OpenRouter (no cost, no rate-limit consumption) and never
 * returns secrets, hostnames or connection strings.
 */
export async function GET(req: Request) {
  const requestId = requestIdFrom(req);
  const startedAt = Date.now();
  const env = getEnv();
  const checks: Record<string, Check> = {};

  if (!isDatabaseConfigured()) checks.database = "not_configured";
  else {
    try {
      await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 2000))]);
      checks.database = "ok";
    } catch {
      checks.database = "down";
    }
  }

  const store = getRateLimitStore();
  checks.rateLimitStore =
    store instanceof RedisRateLimitStore ? ((await store.ping()) ? "ok" : "down") : env.NODE_ENV === "production" ? "degraded" : "ok";

  // "opt_in": remote analysis is configured but runs ONLY for requests that explicitly ask for it
  // (analysisMode "remote-assisted"). The Mac app's local-only gate relies on this contract.
  checks.llm = !env.LLM_ENABLED ? "disabled" : getAIProvider().available ? "opt_in" : "not_configured";

  // ML: primary = local Python service; fallback = embedded portable model.
  const ml = env.ML_ENABLED ? await loadEmbeddedClassifier(env.ML_MODEL_PATH) : null;
  const serviceUp = env.ML_ENABLED && env.ML_BACKEND !== "embedded" ? await new MlServiceClient(env.ML_SERVICE_URL, 1000).health() : false;
  checks.mlService = !env.ML_ENABLED || env.ML_BACKEND === "embedded" ? "disabled" : serviceUp ? "ok" : "down";
  checks.ml = !env.ML_ENABLED ? "disabled" : serviceUp || ml ? (ml?.isSeed ? "degraded" : "ok") : "down";
  checks.ocr = getOcrProvider().available ? "ok" : "disabled";

  // The deterministic pipeline works without LLM/ML; only the database is critical for
  // authenticated features.
  // mlService "down" is tolerated in auto mode (the embedded model takes over) → degraded, not down.
  // Phase 6: message analysis never needs the database (anonymous scans aren't stored; intelligence
  // lookups fail soft), so a database outage is "degraded" — accounts/web history/reports are
  // unavailable — not "down". Reporting "down" made the Mac app refuse to scan while analysis worked.
  const status = Object.values(checks).some((c) => c === "down" || c === "degraded") ? "degraded" : "ok";
  return NextResponse.json(
    {
      success: true,
      data: {
        status,
        checks,
        mlModel: ml ? { ...ml.info, seed: ml.isSeed, backend: env.ML_BACKEND } : null,
        appVersion: env.APP_VERSION,
      },
      meta: { requestId, processingTimeMs: Date.now() - startedAt, version: API_VERSION },
    },
    // Always 200 while the process answers: analysis works even with optional components down.
    { status: 200, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
  );
}
