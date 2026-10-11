import { z } from "zod";

/**
 * Canonical, client-safe schemas and types shared by the server pipeline and the UI.
 * This file must not import server-only modules.
 */

export const SCAM_CATEGORIES = [
  "phishing",
  "banking",
  "upi",
  "kyc",
  "job",
  "investment",
  "lottery",
  "delivery",
  "loan",
  "government_impersonation",
  "tech_support",
  "romance",
  "malware",
  "credential_theft",
  "other",
] as const;
export const ScamCategorySchema = z.enum(SCAM_CATEGORIES);
export type ScamCategory = z.infer<typeof ScamCategorySchema>;

export const CATEGORY_LABELS: Record<ScamCategory, string> = {
  phishing: "Phishing",
  banking: "Banking Fraud",
  upi: "UPI Fraud",
  kyc: "KYC Scam",
  job: "Job Scam",
  investment: "Investment Scam",
  lottery: "Lottery / Prize Scam",
  delivery: "Delivery Scam",
  loan: "Loan Scam",
  government_impersonation: "Government Impersonation",
  tech_support: "Tech Support Scam",
  romance: "Romance Scam",
  malware: "Malware",
  credential_theft: "Credential Theft",
  other: "Other",
};

export const CLASSIFICATIONS = ["safe", "suspicious", "scam"] as const;
export const ClassificationSchema = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof ClassificationSchema>;

/** User-facing risk levels (SAFE / SUSPICIOUS / HIGH RISK / CRITICAL). */
export const RISK_LEVELS = ["safe", "suspicious", "high", "critical"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  safe: "SAFE",
  suspicious: "SUSPICIOUS",
  high: "HIGH RISK",
  critical: "CRITICAL",
};

export const SeveritySchema = z.enum(["low", "medium", "high"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SignalSourceSchema = z.enum(["rules", "ml", "url", "llm"]);
export type SignalSource = z.infer<typeof SignalSourceSchema>;

export const InputTypeSchema = z.enum(["message", "url", "image", "email"]);
export type InputType = z.infer<typeof InputTypeSchema>;

export const IndicatorSchema = z.object({
  source: z.enum(["rules", "ml", "url", "llm", "email", "intel"]),
  type: z.string().max(80),
  severity: SeveritySchema,
  evidence: z.string().max(300),
  category: ScamCategorySchema.optional(),
});
export type Indicator = z.infer<typeof IndicatorSchema>;

export const SignalContributionSchema = z.object({
  source: SignalSourceSchema,
  available: z.boolean(),
  score: z.number().min(0).max(100).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  configuredWeight: z.number().min(0).max(1),
  effectiveWeight: z.number().min(0).max(1),
  contribution: z.number(),
  note: z.string().optional(),
});
export type SignalContribution = z.infer<typeof SignalContributionSchema>;

export const FusionAdjustmentSchema = z.object({
  kind: z.enum(["floor", "boost", "cap"]),
  reason: z.string(),
  from: z.number(),
  to: z.number(),
});
export type FusionAdjustment = z.infer<typeof FusionAdjustmentSchema>;

export const UrlFindingSchema = z.object({
  url: z.string(),
  hostname: z.string(),
  registrableDomain: z.string().nullable(),
  riskScore: z.number().min(0).max(100),
  flags: z.array(z.object({ id: z.string(), severity: SeveritySchema, detail: z.string() })),
  redirectChain: z.array(z.string()).optional(),
  finalUrl: z.string().optional(),
  /**
   * What ScamShield's intelligence knows about the domain. "unknown" means no record — it is NOT
   * evidence of safety (and the flags above are NOT proof of fraud).
   */
  reputation: z.enum(["unknown", "suspicious", "confirmed_malicious", "benign_reports"]).default("unknown"),
  /** Provenance of `reputation`: whether any reputation source was actually consulted. */
  intel: z
    .object({
      /** False = no source could be consulted (database down / none configured): "unknown" then means "not checked". */
      checked: z.boolean(),
      checkedBy: z.array(z.string()),
      /** Sources that had a record for this domain. */
      sources: z.array(z.string()),
      evidence: z.array(z.string()),
      /** 0–1 malicious confidence from the strongest record; null when no record. */
      confidence: z.number().min(0).max(1).nullable(),
      lastUpdated: z.string().nullable(),
    })
    .optional(),
});
export type UrlFinding = z.infer<typeof UrlFindingSchema>;

export const AnalysisResultSchema = z.object({
  id: z.string().nullable(),
  inputType: InputTypeSchema,
  classification: ClassificationSchema,
  riskLevel: RiskLevelSchema,
  riskScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  category: ScamCategorySchema,
  categoryLabel: z.string(),
  reasons: z.array(z.string()),
  indicators: z.array(IndicatorSchema),
  suspiciousEntities: z.array(z.string()),
  urls: z.array(UrlFindingSchema),
  recommendedActions: z.array(z.string()),
  explanation: z.string(),
  aiSummary: z.string().nullable(),
  signals: z.array(SignalContributionSchema),
  adjustments: z.array(FusionAdjustmentSchema),
  modelMetadata: z.object({
    llm: z
      .object({
        provider: z.string(),
        model: z.string(),
        status: z.enum(["ok", "fallback", "unavailable", "disabled", "skipped"]),
        attempts: z.number().int(),
      })
      .nullable(),
    ml: z.object({ version: z.string(), seedModel: z.boolean() }).nullable(),
  }),
  intel: z.object({ knownPattern: z.boolean(), reportCount: z.number().int() }),
  /**
   * Remote (OpenRouter) analysis for this request. `used` is true only if a remote verdict was
   * received and validated. `reason` is a diagnostic code, never content.
   */
  remoteAnalysis: z
    .object({
      requested: z.boolean(),
      used: z.boolean(),
      status: z.enum(["not_requested", "disabled_on_server", "not_configured", "ok", "unavailable", "ignored"]),
      model: z.string().nullable(),
      reason: z.string().nullable(),
      sentChars: z.number().int().nonnegative(),
    })
    .default({ requested: false, used: false, status: "not_requested", model: null, reason: null, sentChars: 0 }),
  warnings: z.array(z.string()),
  /**
   * Whether the local evidence was complete enough to call a message safe. "insufficient": nothing
   * suspicious was found, but a detector failed (ML model unavailable with no AI second opinion, or a
   * rule errored) — clients must show "Unable to assess", never a green/safe result.
   */
  assessment: z
    .object({ status: z.enum(["complete", "insufficient"]), reasons: z.array(z.string()) })
    .default({ status: "complete", reasons: [] }),
  /** Why this colour, from the actual evidence (see detection/decision.ts). */
  decision: z
    .object({
      colour: z.enum(["green", "orange", "red", "grey"]),
      why: z.string(),
      basis: z.array(z.string()),
      matches: z.array(z.object({ rule: z.string(), text: z.string(), severity: SeveritySchema })),
      thresholds: z.object({ suspicious: z.number(), high: z.number(), critical: z.number() }),
    })
    .optional(),
  /** Present for screen scans: how many text areas were found and which one the result is about. */
  screen: z.object({ blocks: z.number().int(), analysed: z.number().int(), selectedBlock: z.number().int().nullable() }).optional(),
  /** The ML model that contributed to this result (null if ML was unavailable/disabled). */
  model: z
    .object({ name: z.string(), version: z.string(), buildId: z.string(), backend: z.enum(["service", "embedded"]) })
    .nullable()
    .default(null),
  processingTimeMs: z.number().nonnegative().default(0),
  createdAt: z.string(),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

/** History list item (client-safe; no raw content). */
export interface HistoryItem {
  id: string;
  inputType: InputType;
  classification: Classification;
  riskLevel: RiskLevel;
  riskScore: number;
  confidence: number;
  category: ScamCategory;
  categoryLabel: string;
  preview: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ReportItem {
  id: string;
  reportType: string;
  category: ScamCategory;
  categoryLabel: string;
  preview: string;
  domain: string | null;
  status: "pending" | "confirmed" | "rejected";
  /** Number of ScamShield users who reported the same content (including you). */
  communityReports: number;
  createdAt: string;
}

export interface DashboardStats {
  totalScans: number;
  scamsDetected: number;
  suspicious: number;
  safe: number;
  reportsSubmitted: number;
  topCategories: Array<{ category: ScamCategory; label: string; count: number }>;
  recent: HistoryItem[];
}
