import { prisma } from "@/lib/db/prisma";
import { CATEGORY_LABELS, type DashboardStats } from "@/lib/schemas/analysis";
import { toCategory, toHistoryItem } from "./mappers";

/** Per-user dashboard numbers computed from real stored analyses only (no placeholders). */
export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const live = { userId, expiresAt: { gt: new Date() } };
  const [byClass, topCats, recent, reportsSubmitted] = await Promise.all([
    prisma.scamAnalysis.groupBy({ by: ["classification"], where: live, _count: { _all: true } }),
    prisma.scamAnalysis.groupBy({
      by: ["category"],
      where: { ...live, classification: { not: "SAFE" }, category: { not: "other" } },
      _count: { _all: true },
      orderBy: { _count: { category: "desc" } },
      take: 6,
    }),
    prisma.scamAnalysis.findMany({
      where: live,
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
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
      },
    }),
    prisma.scamReport.count({ where: { userId } }),
  ]);
  const count = (c: "SAFE" | "SUSPICIOUS" | "SCAM") => byClass.find((b) => b.classification === c)?._count._all ?? 0;
  return {
    totalScans: byClass.reduce((a, b) => a + b._count._all, 0),
    scamsDetected: count("SCAM"),
    suspicious: count("SUSPICIOUS"),
    safe: count("SAFE"),
    reportsSubmitted,
    topCategories: topCats.map((c) => {
      const category = toCategory(c.category);
      return { category, label: CATEGORY_LABELS[category], count: c._count._all };
    }),
    recent: recent.map(toHistoryItem),
  };
}
