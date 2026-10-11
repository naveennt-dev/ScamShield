import type { ScamAnalysis } from "@prisma/client";
import {
  CATEGORY_LABELS,
  ScamCategorySchema,
  type Classification,
  type HistoryItem,
  type InputType,
  type RiskLevel,
  type ScamCategory,
} from "@/lib/schemas/analysis";

export const toCategory = (c: string): ScamCategory => {
  const p = ScamCategorySchema.safeParse(c);
  return p.success ? p.data : "other";
};

export const fromDbInputType = (t: string) => t.toLowerCase() as InputType;
export const fromDbClassification = (c: string) => c.toLowerCase() as Classification;
export const fromDbRiskLevel = (r: string) => r.toLowerCase() as RiskLevel;

export function toHistoryItem(
  a: Pick<
    ScamAnalysis,
    "id" | "inputType" | "classification" | "riskLevel" | "riskScore" | "confidence" | "category" | "contentPreview" | "createdAt" | "expiresAt"
  >,
): HistoryItem {
  const category = toCategory(a.category);
  return {
    id: a.id,
    inputType: fromDbInputType(a.inputType),
    classification: fromDbClassification(a.classification),
    riskLevel: fromDbRiskLevel(a.riskLevel),
    riskScore: a.riskScore,
    confidence: a.confidence,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    preview: a.contentPreview,
    createdAt: a.createdAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
  };
}
