import { z } from "zod";

/**
 * Server-side configuration, validated once with Zod.
 *
 * Never import this module from client components: it reads secrets.
 * Empty strings are treated as "unset" so `.env` templates with blank values behave sensibly.
 */

const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));
const num = (def: number, min = 0, max = 1) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).max(max).default(def));
const bool = (def: boolean) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim().toLowerCase()) : v),
    z
      .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
      .default(def)
      .transform((v) => v === true || v === "true" || v === "1" || v === "yes"),
  );
const csv = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_VERSION: z.preprocess(emptyToUndefined, z.string().default("1.0.0")),
  APP_URL: optionalString,

  DATABASE_URL: optionalString,

  // ---- OpenRouter -------------------------------------------------------
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default("https://openrouter.ai/api/v1"),
  ),
  SCAM_PRIMARY_MODEL: optionalString,
  SCAM_FALLBACK_MODEL: optionalString,
  SCAM_FAST_MODEL: optionalString,
  // Phase 4: interactive budgets (the Mac app waits for the result). Bounded, never endless.
  // Measured 2026-10-10: free reasoning models (e.g. nemotron-3-super) take 6–12 s and ~840
  // completion tokens for our prompt, so 10 s / 900 tokens cut them off.
  OPENROUTER_TIMEOUT_MS: int(20000, 1000, 120000),
  OPENROUTER_MAX_RETRIES: int(1, 0, 5),
  OPENROUTER_TOTAL_BUDGET_MS: int(25000, 1000, 180000),
  OPENROUTER_MAX_TOKENS: int(1500, 100, 4000),
  /** Only OpenRouter `:free` models whose catalogue price is 0 are ever called (no paid fallback). */
  OPENROUTER_REQUIRE_FREE_MODELS: bool(true),
  /** Most characters of (minimised) text that may leave the machine for one analysis. */
  OPENROUTER_MAX_INPUT_CHARS: int(3000, 200, 6000),
  // Detection is local (rules + ML). The remote LLM layer is OFF unless explicitly enabled here
  // AND requested per scan by the client (`analysisMode: "remote-assisted"`).
  LLM_ENABLED: bool(false),

  // ---- ML -----------------------------------------------------------------
  ML_MODEL_PATH: z.preprocess(emptyToUndefined, z.string().default("ml/models/scam_classifier.json")),
  ML_ENABLED: bool(true),
  ML_BACKEND: z.preprocess(emptyToUndefined, z.enum(["auto", "service", "embedded"]).default("auto")),
  ML_SERVICE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .default("http://127.0.0.1:8765")
      .refine((u) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname), "ML_SERVICE_URL must be a loopback address"),
  ),
  ML_SERVICE_TIMEOUT_MS: int(1500, 100, 30000),

  // ---- Risk thresholds (score ≥ threshold ⇒ level). Starting points; calibrate on validation data.
  RISK_THRESHOLD_SUSPICIOUS: int(30, 1, 99),
  RISK_THRESHOLD_HIGH: int(60, 2, 99),
  RISK_THRESHOLD_CRITICAL: int(85, 3, 100),
  // Model-only evidence (no rule, no risky link) can raise a result to SUSPICIOUS at most.
  RISK_CAP_UNCORROBORATED_ML: bool(true),

  // ---- Risk fusion weights (relative, renormalised over available signals) --
  RISK_WEIGHT_ML: num(0.35, 0, 1),
  RISK_WEIGHT_RULES: num(0.3, 0, 1),
  RISK_WEIGHT_URL: num(0.2, 0, 1),
  RISK_WEIGHT_LLM: num(0.15, 0, 1),

  // ---- Input limits -------------------------------------------------------
  MAX_MESSAGE_LENGTH: int(10000, 100, 100000),
  MAX_BODY_BYTES: int(64 * 1024, 1024, 5 * 1024 * 1024),
  MAX_IMAGE_BYTES: int(5 * 1024 * 1024, 10 * 1024, 20 * 1024 * 1024),

  // ---- URL fetching (redirect resolution) ---------------------------------
  URL_FETCH_ENABLED: bool(false),
  /** URL threat-intelligence providers (link scans). Off unless a key is set. */
  URLHAUS_AUTH_KEY: optionalString,
  PHISHTANK_APP_KEY: optionalString,
  /** Optional dynamic page inspection (headless Chromium behind the SSRF proxy). Off unless true. */
  DYNAMIC_INSPECTION_ENABLED: bool(false),
  /** Let the local ScamShield Link Guard extension call the link scanner (loopback only). */
  ALLOW_BROWSER_EXTENSION: bool(false),
  /**
   * "desktop": the on-device engine bundled in the apps (single process, loopback only — in-memory
   * rate limits and no database are the intended design). "server": a deployed service.
   */
  SCAMSHIELD_EDITION: z.enum(["server", "desktop"]).default("server"),
  DYNAMIC_INSPECTION_TIMEOUT_MS: int(20000, 5000, 60000),
  URL_FETCH_TIMEOUT_MS: int(5000, 500, 20000),
  URL_FETCH_MAX_REDIRECTS: int(5, 0, 10),
  URL_FETCH_MAX_BYTES: int(256 * 1024, 1024, 2 * 1024 * 1024),

  // ---- OCR ----------------------------------------------------------------
  OCR_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["tesseract", "disabled"]).default("tesseract")),
  OCR_TIMEOUT_MS: int(20000, 1000, 120000),
  OCR_TESSERACT_LANG_PATH: optionalString,

  // ---- Rate limiting --------------------------------------------------------
  REDIS_URL: optionalString,
  RATE_LIMIT_ENABLED: bool(true),
  ALLOW_ANONYMOUS_ANALYSIS: bool(true),
  /** Accept opt-in shared-learning contributions (POST /api/v1/contributions). */
  CONTRIBUTIONS_ENABLED: bool(false),
  TRUST_PROXY_HEADERS: bool(true),
  /**
   * Phase 6: give loopback clients (the Mac app on this machine) the "local" rate-limit tier.
   * Off by default; scripts/local-stack.sh turns it on for the loopback-only personal stack. Never
   * enable it on a server reachable from other machines.
   */
  LOCAL_CLIENT_RATE_TIER: bool(false),

  // ---- HTTP -----------------------------------------------------------------
  CORS_ALLOWED_ORIGINS: csv,

  // ---- Privacy / retention ----------------------------------------------------
  DEFAULT_RETENTION_DAYS: int(90, 1, 3650),
  EVENT_RETENTION_DAYS: int(30, 1, 3650),
  CRON_SECRET: optionalString,

  // ---- Observability -------------------------------------------------------------
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["debug", "info", "warn", "error"]).default("info")),
  METRICS_TOKEN: optionalString,
  SENTRY_DSN: optionalString,

  // ---- Auth -------------------------------------------------------------------------
  BETTER_AUTH_SECRET: optionalString,
  BETTER_AUTH_URL: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  AUTH_ENABLE_EMAIL_PASSWORD: bool(false),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Only variable names and messages are reported – never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const t = parsed.data;
  if (!(t.RISK_THRESHOLD_SUSPICIOUS < t.RISK_THRESHOLD_HIGH && t.RISK_THRESHOLD_HIGH < t.RISK_THRESHOLD_CRITICAL)) {
    throw new Error("Invalid environment configuration: RISK_THRESHOLD_SUSPICIOUS < RISK_THRESHOLD_HIGH < RISK_THRESHOLD_CRITICAL required");
  }
  cached = t;
  return cached;
}

/** Test helper: forget the cached config so tests can change process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export const isProduction = () => getEnv().NODE_ENV === "production";
