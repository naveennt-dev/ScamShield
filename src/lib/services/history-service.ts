import { prisma } from "@/lib/db/prisma";
import {
  AnalysisResultSchema,
  CATEGORY_LABELS,
  type AnalysisResult,
  type HistoryItem,
  type Indicator,
  type UrlFinding,
} from "@/lib/schemas/analysis";
import { fromDbClassification, fromDbInputType, fromDbRiskLevel, toCategory, toHistoryItem } from "./mappers";

/**
 * Every query is scoped by the authenticated user's id (from the session). A user requesting
 * someone else's analysis gets "not found" — existence is not revealed.
 */

const LIST_SELECT = {
  id: true,
  inputType: true,
  classification: true,
  riskLevel: true,
  riskScore: true,
  confidence: true,
  category: true,
  contentPreview: true,
  createdAt: true,
  expiresAt: true,
} as const;

export async function listHistory(
  userId: string,
  q: { cursor?: string; limit: number; classification?: "safe" | "suspicious" | "scam"; inputType?: "message" | "url" | "image" | "email" },
): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
  const rows = await prisma.scamAnalysis.findMany({
    where: {
      userId,
      expiresAt: { gt: new Date() },
      ...(q.classification ? { classification: q.classification.toUpperCase() as "SAFE" | "SUSPICIOUS" | "SCAM" } : {}),
      ...(q.inputType ? { inputType: q.inputType.toUpperCase() as "MESSAGE" | "URL" | "IMAGE" | "EMAIL" } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: LIST_SELECT,
  });
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return { items: page.map(toHistoryItem), nextCursor: hasMore ? page[page.length - 1].id : null };
}

export interface StoredAnalysis extends AnalysisResult {
  preview: string | null;
  expiresAt: string;
}

export async function getAnalysis(userId: string, id: string): Promise<StoredAnalysis | null> {
  const a = await prisma.scamAnalysis.findFirst({
    where: { id, userId, expiresAt: { gt: new Date() } },
    include: { indicators: true, urlAnalyses: true },
  });
  if (!a) return null;
  const category = toCategory(a.category);
  const signalsBlob = (a.signals ?? {}) as {
    contributions?: unknown;
    warnings?: unknown;
    intel?: unknown;
    modelMetadata?: AnalysisResult["modelMetadata"];
  };

  const candidate = {
    id: a.id,
    inputType: fromDbInputType(a.inputType),
    classification: fromDbClassification(a.classification),
    riskLevel: fromDbRiskLevel(a.riskLevel),
    riskScore: a.riskScore,
    confidence: a.confidence,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    reasons: Array.isArray(a.reasons) ? a.reasons : [],
    indicators: a.indicators.map((i) => ({
      source: i.source,
      type: i.type,
      severity: i.severity,
      evidence: i.evidence,
      ...(i.category ? { category: toCategory(i.category) } : {}),
    })) as Indicator[],
    suspiciousEntities: a.urlAnalyses.filter((u) => u.riskScore >= 30).map((u) => u.hostname),
    urls: a.urlAnalyses.map((u) => ({
      url: u.hostname,
      hostname: u.hostname,
      registrableDomain: u.domain,
      riskScore: u.riskScore,
      flags: Array.isArray(u.flags) ? u.flags : [],
      ...(u.finalDomain ? { finalUrl: u.finalDomain } : {}),
    })) as UrlFinding[],
    recommendedActions: Array.isArray(a.recommendedActions) ? a.recommendedActions : [],
    explanation: a.explanation,
    aiSummary: a.aiSummary,
    signals: Array.isArray(signalsBlob.contributions) ? signalsBlob.contributions : [],
    adjustments: Array.isArray(a.adjustments) ? a.adjustments : [],
    modelMetadata: signalsBlob.modelMetadata ?? {
      llm: a.llmProvider ? { provider: a.llmProvider, model: a.llmModel ?? "none", status: a.llmStatus, attempts: 0 } : null,
      ml: null,
    },
    intel: (signalsBlob.intel as AnalysisResult["intel"]) ?? { knownPattern: false, reportCount: 0 },
    warnings: Array.isArray(signalsBlob.warnings) ? signalsBlob.warnings : [],
    createdAt: a.createdAt.toISOString(),
  };
  // Re-validate stored JSON before returning it (defends against schema drift in old rows).
  const parsed = AnalysisResultSchema.safeParse(candidate);
  const result = parsed.success ? parsed.data : (candidate as unknown as AnalysisResult);
  return { ...result, preview: a.contentPreview, expiresAt: a.expiresAt.toISOString() };
}

export async function deleteAnalysis(userId: string, id: string): Promise<boolean> {
  const res = await prisma.scamAnalysis.deleteMany({ where: { id, userId } });
  return res.count > 0;
}

export async function deleteAllHistory(userId: string): Promise<number> {
  const res = await prisma.scamAnalysis.deleteMany({ where: { userId } });
  return res.count;
}
