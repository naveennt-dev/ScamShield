import { Prisma } from "@prisma/client";
import { parse as parseDomain } from "tldts";
import { prisma } from "@/lib/db/prisma";
import { fingerprint, simhash, simhashBands, simhashHex } from "@/lib/detection/fingerprint";
import { safePreview } from "@/lib/observability/redact";
import { CATEGORY_LABELS, type ReportItem } from "@/lib/schemas/analysis";
import type { CreateReportInput } from "@/lib/schemas/api";
import { extractUrls, normalizeUrl } from "@/lib/url/extractor";
import { patternConfidence } from "@/lib/intel/service";
import { upsertIntelRecord } from "@/lib/intel/records";
import { logger } from "@/lib/observability/logger";
import { ApiError } from "@/lib/api/errors";
import { toCategory } from "./mappers";

/**
 * User scam reports → intelligence patterns.
 *
 * - One report per user per content fingerprint (DB unique constraint) so one account cannot
 *   inflate counts.
 * - Patterns accumulate `reportCount` and `distinctReporters`; their confidence is capped and
 *   only used for scoring after MIN_DISTINCT_REPORTERS (see intel/service.ts).
 * - Reports from other users are never shown to anyone; only aggregate counts are exposed.
 */

function primaryDomain(input: CreateReportInput): string | null {
  const url = input.reportType === "url" ? normalizeUrl(input.content) : extractUrls(input.content)[0]?.url;
  if (!url) return null;
  try {
    return parseDomain(new URL(url).hostname).domain ?? null;
  } catch {
    return null;
  }
}

export async function createReport(userId: string, input: CreateReportInput): Promise<ReportItem> {
  const content = input.reportType === "url" ? (normalizeUrl(input.content) ?? input.content.trim()) : input.content;
  const fp = fingerprint(content);
  const sh = simhash(content);
  const [b0, b1, b2, b3] = simhashBands(sh);
  const domain = primaryDomain(input);

  if (input.analysisId) {
    const owned = await prisma.scamAnalysis.findFirst({ where: { id: input.analysisId, userId }, select: { id: true } });
    if (!owned) throw new ApiError("NOT_FOUND", "The referenced analysis was not found.");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const domainAlreadyReported = domain
        ? (await tx.scamReport.count({ where: { userId, domain } })) > 0
        : true;

      const report = await tx.scamReport.create({
        data: {
          userId,
          analysisId: input.analysisId ?? null,
          reportType: input.reportType,
          category: input.category,
          fingerprint: fp,
          domain,
          contentPreview: safePreview(content, 280),
          note: input.note ? safePreview(input.note, 500) : null,
          verdict: input.verdict,
        },
      });

      // A "this was wrongly flagged" report is stored for review but never feeds scam patterns.
      if (input.verdict === "false_positive") {
        const category = toCategory(report.category);
        return {
          id: report.id,
          reportType: report.reportType,
          category,
          categoryLabel: CATEGORY_LABELS[category],
          preview: report.contentPreview,
          domain: report.domain,
          status: "pending" as const,
          communityReports: 0,
          createdAt: report.createdAt.toISOString(),
          newDomainReport: Boolean(domain && !domainAlreadyReported),
        };
      }

      const pattern = await tx.scamPattern.upsert({
        where: { patternType_value: { patternType: "MESSAGE_FINGERPRINT", value: fp } },
        create: {
          patternType: "MESSAGE_FINGERPRINT",
          value: fp,
          category: input.category,
          simhash: simhashHex(sh),
          simhashBand0: b0,
          simhashBand1: b1,
          simhashBand2: b2,
          simhashBand3: b3,
          reportCount: 1,
          distinctReporters: 1,
          confidence: patternConfidence(1, "UNVERIFIED"),
        },
        update: {
          reportCount: { increment: 1 },
          distinctReporters: { increment: 1 },
          lastSeen: new Date(),
        },
      });
      if (pattern.status === "UNVERIFIED") {
        await tx.scamPattern.update({
          where: { id: pattern.id },
          data: {
            confidence: patternConfidence(pattern.distinctReporters, "UNVERIFIED"),
            ...(pattern.category === "other" && input.category !== "other" ? { category: input.category } : {}),
          },
        });
      }

      if (domain && !domainAlreadyReported) {
        const d = await tx.scamPattern.upsert({
          where: { patternType_value: { patternType: "DOMAIN", value: domain } },
          create: {
            patternType: "DOMAIN",
            value: domain,
            category: input.category,
            reportCount: 1,
            distinctReporters: 1,
            confidence: patternConfidence(1, "UNVERIFIED"),
          },
          update: { reportCount: { increment: 1 }, distinctReporters: { increment: 1 }, lastSeen: new Date() },
        });
        if (d.status === "UNVERIFIED") {
          await tx.scamPattern.update({ where: { id: d.id }, data: { confidence: patternConfidence(d.distinctReporters, "UNVERIFIED") } });
        }
      }

      const category = toCategory(report.category);
      return {
        id: report.id,
        reportType: report.reportType,
        category,
        categoryLabel: CATEGORY_LABELS[category],
        preview: report.contentPreview,
        domain: report.domain,
        status: "pending" as const,
        communityReports: pattern.reportCount,
        createdAt: report.createdAt.toISOString(),
        newDomainReport: Boolean(domain && !domainAlreadyReported),
      };
    });
    // Separate, provenance-tagged intelligence record (one observation per reporter per domain).
    // USER_REPORT is capped at SUSPICIOUS by the records service — a report never "confirms".
    if (domain && result.newDomainReport) {
      await upsertIntelRecord({
        kind: "DOMAIN",
        value: domain,
        sourceType: "USER_REPORT",
        status: input.verdict === "false_positive" ? "BENIGN" : "SUSPICIOUS",
        category: input.category,
        confidence: input.verdict === "false_positive" ? 0.3 : 0.4,
        explanation: input.verdict === "false_positive" ? "Reported by a user as wrongly flagged" : "Reported by a user as a scam",
        sourceName: "user-report",
        updateMethod: "report",
      }).catch((error) => logger.warn("intel_record_from_report_failed", { error }));
    }
    const { newDomainReport: _omit, ...item } = result;
    void _omit;
    return item;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ApiError("CONFLICT", "You have already reported this content.");
    }
    throw e;
  }
}

export async function listReports(userId: string, limit = 50): Promise<ReportItem[]> {
  const reports = await prisma.scamReport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const patterns = await prisma.scamPattern.findMany({
    where: { patternType: "MESSAGE_FINGERPRINT", value: { in: reports.map((r) => r.fingerprint) } },
    select: { value: true, reportCount: true },
  });
  const counts = new Map(patterns.map((p) => [p.value, p.reportCount]));
  return reports.map((r) => {
    const category = toCategory(r.category);
    return {
      id: r.id,
      reportType: r.reportType,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      preview: r.contentPreview,
      domain: r.domain,
      status: r.status.toLowerCase() as ReportItem["status"],
      communityReports: counts.get(r.fingerprint) ?? 1,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
