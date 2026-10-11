import { z } from "zod";
import {
  ClassificationSchema,
  ScamCategorySchema,
  SCAM_CATEGORIES,
  type Classification,
  type ScamCategory,
  type Severity,
} from "@/lib/schemas/analysis";
import { AIError } from "./errors";

/**
 * Validation of raw LLM output. The LLM is untrusted: every field is parsed, bounded and
 * normalised here. Anything that fails is treated as a malformed response.
 */

const truncated = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

const CATEGORY_ALIASES: Record<string, ScamCategory> = {
  bank: "banking",
  "banking fraud": "banking",
  "upi fraud": "upi",
  "kyc scam": "kyc",
  "job scam": "job",
  employment: "job",
  "investment scam": "investment",
  crypto: "investment",
  lottery_prize: "lottery",
  prize: "lottery",
  "lottery/prize": "lottery",
  parcel: "delivery",
  courier: "delivery",
  government: "government_impersonation",
  "government impersonation": "government_impersonation",
  impersonation: "government_impersonation",
  "tech support": "tech_support",
  techsupport: "tech_support",
  credential: "credential_theft",
  "credential theft": "credential_theft",
  none: "other",
  safe: "other",
  spam: "other",
};

function normalizeCategory(v: unknown): unknown {
  const s = lower(v);
  if (typeof s !== "string") return s;
  if ((SCAM_CATEGORIES as readonly string[]).includes(s)) return s;
  return CATEGORY_ALIASES[s] ?? CATEGORY_ALIASES[s.replace(/[_-]/g, " ")] ?? "other";
}

/** Numbers may arrive as numeric strings ("85"); anything else non-finite is rejected. */
const numeric = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
  z.number().finite(),
);

export const LLMIndicatorSchema = z.object({
  type: truncated(80),
  severity: z.preprocess(lower, z.enum(["low", "medium", "high"])).catch("medium" as Severity),
  evidence: truncated(300).default(""),
});

export const LLMScamResponseSchema = z.object({
  classification: z.preprocess(lower, ClassificationSchema),
  category: z.preprocess(normalizeCategory, ScamCategorySchema),
  riskScore: numeric.pipe(z.number().min(0).max(100)),
  confidence: numeric.pipe(z.number().min(0).max(1)),
  indicators: z
    .array(LLMIndicatorSchema)
    .default([])
    .transform((a) => a.slice(0, 15)),
  suspiciousEntities: z
    .array(truncated(200))
    .default([])
    .transform((a) => a.slice(0, 20)),
  recommendedActions: z
    .array(truncated(300))
    .default([])
    .transform((a) => a.slice(0, 8)),
  explanation: truncated(2000),
});
export type LLMScamResponse = z.infer<typeof LLMScamResponseSchema>;

/**
 * Extracts a JSON object from model text. Handles code fences, leading prose and
 * `<think>` blocks emitted by reasoning models. Never evaluates anything.
 */
export function extractJsonObject(raw: string): unknown {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new AIError("MALFORMED_RESPONSE", "No JSON object found in model output");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (cause) {
    throw new AIError("MALFORMED_RESPONSE", "Model output is not valid JSON", { cause });
  }
}

export function parseLLMScamResponse(raw: string): LLMScamResponse {
  const json = extractJsonObject(raw);
  const parsed = LLMScamResponseSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(",");
    throw new AIError("SCHEMA_INVALID", `Model output failed schema validation: ${fields}`);
  }
  return sanitizeLLMOutput(parsed.data);
}

const URL_OR_PHONE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|xyz|top|info|io|co)\b|\+?\d[\d\s-]{7,}\d)/i;

/**
 * Defence-in-depth: an LLM manipulated by injected content could recommend "click this link"
 * or "call this number". Recommended actions containing URLs/phone numbers are dropped.
 */
export function sanitizeLLMOutput(r: LLMScamResponse): LLMScamResponse {
  return {
    ...r,
    recommendedActions: r.recommendedActions.filter((a) => a.length > 0 && !URL_OR_PHONE.test(a)),
    explanation: r.explanation.replace(/<[^>]{0,200}>/g, ""),
  };
}

export interface ScamAIInput {
  /** Untrusted content to analyse. */
  text: string;
  inputType: "message" | "url" | "image" | "email";
  /** Deterministic findings offered as context (never as instructions). */
  hints: string[];
  requestId: string;
  tier?: "standard" | "fast";
}

export interface ScamAIResult {
  analysis: LLMScamResponse;
  classification: Classification;
  modelMetadata: { provider: string; model: string };
  attempts: number;
  usedFallback: boolean;
  latencyMs: number;
}
