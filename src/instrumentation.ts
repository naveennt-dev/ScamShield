/**
 * Next.js instrumentation hook: runs once per server instance at startup.
 * Logs a configuration summary (never secret values) and surfaces production misconfiguration.
 * This is also where an error reporter (Sentry, etc.) should be registered — see
 * src/lib/observability/error-reporting.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("@/lib/config/env");
  const { logger } = await import("@/lib/observability/logger");

  let env;
  try {
    env = getEnv();
  } catch (e) {
    logger.error("config_invalid", { error: e });
    return;
  }
  const models = [env.SCAM_PRIMARY_MODEL, env.SCAM_FALLBACK_MODEL, env.SCAM_FAST_MODEL].filter(Boolean).length;
  logger.info("startup_config", {
    nodeEnv: env.NODE_ENV,
    appVersion: env.APP_VERSION,
    database: Boolean(env.DATABASE_URL),
    redis: Boolean(env.REDIS_URL),
    llmEnabled: env.LLM_ENABLED,
    openrouterKey: Boolean(env.OPENROUTER_API_KEY),
    llmModelsConfigured: models,
    mlEnabled: env.ML_ENABLED,
    ocrProvider: env.OCR_PROVIDER,
    urlFetchEnabled: env.URL_FETCH_ENABLED,
    corsOrigins: env.CORS_ALLOWED_ORIGINS.length,
    metricsEnabled: Boolean(env.METRICS_TOKEN),
    retentionCron: Boolean(env.CRON_SECRET),
  });

  if (env.NODE_ENV === "production") {
    const problems: string[] = [];
    if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) problems.push("BETTER_AUTH_SECRET missing or shorter than 32 chars");
    if (!env.REDIS_URL) problems.push("REDIS_URL not set (rate limits are per-instance)");
    if (!env.DATABASE_URL) problems.push("DATABASE_URL not set");
    if (!env.CRON_SECRET) problems.push("CRON_SECRET not set (retention job disabled)");
    if (env.LLM_ENABLED && (!env.OPENROUTER_API_KEY || models === 0)) problems.push("LLM enabled but OpenRouter key/models missing (deterministic mode only)");
    if (env.AUTH_ENABLE_EMAIL_PASSWORD) problems.push("AUTH_ENABLE_EMAIL_PASSWORD=true (intended for local/E2E only)");
    for (const p of problems) logger.warn("production_config_warning", { problem: p });
  }
}
