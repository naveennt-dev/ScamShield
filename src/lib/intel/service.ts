import { prisma, isDatabaseConfigured } from "@/lib/db/prisma";
import { logger } from "@/lib/observability/logger";
import { ScamCategorySchema, type ScamCategory } from "@/lib/schemas/analysis";
import type { RuleSignal } from "@/lib/detection/types";
import { hammingDistance, simhashBands } from "@/lib/detection/fingerprint";
import type { DomainReputation, DomainReputationProvider } from "@/lib/url/types";
import { intelDomainReputation } from "./records";

/**
 * Scam-intelligence layer built from user reports.
 *
 * Reports are NOT ground truth. A pattern only influences scoring once at least
 * MIN_DISTINCT_REPORTERS different accounts reported it (or a reviewer marked it TRUSTED), and its
 * weight is capped so crowd reports alone cannot push a message to CRITICAL. Rejected patterns
 * are ignored. Nothing here exposes who reported what or any message content.
 */

export const MIN_DISTINCT_REPORTERS = 2;
const MAX_UNVERIFIED_CONFIDENCE = 0.7;
const NEAR_DUPLICATE_MAX_DISTANCE = 3;

export function patternConfidence(distinctReporters: number, status: "UNVERIFIED" | "TRUSTED" | "REJECTED"): number {
  if (status === "REJECTED") return 0;
  if (status === "TRUSTED") return 0.95;
  return Math.min(MAX_UNVERIFIED_CONFIDENCE, Number((1 - Math.exp(-distinctReporters / 4)).toFixed(3)));
}

export interface PatternMatch {
  knownPattern: boolean;
  reportCount: number;
  distinctReporters: number;
  confidence: number;
  category: ScamCategory;
  nearDuplicate: boolean;
}

export interface IntelService {
  lookupMessage(fingerprint: string, simhash: bigint): Promise<PatternMatch | null>;
  domainReputation: DomainReputationProvider;
}

function toCategory(c: string): ScamCategory {
  const p = ScamCategorySchema.safeParse(c);
  return p.success ? p.data : "other";
}

export const prismaIntelService: IntelService = {
  async lookupMessage(fp, sh) {
    if (!isDatabaseConfigured()) return null;
    try {
      const exact = await prisma.scamPattern.findUnique({
        where: { patternType_value: { patternType: "MESSAGE_FINGERPRINT", value: fp } },
      });
      let match = exact && exact.status !== "REJECTED" ? { p: exact, near: false } : null;
      if (!match) {
        const [b0, b1, b2, b3] = simhashBands(sh);
        const candidates = await prisma.scamPattern.findMany({
          where: {
            patternType: "MESSAGE_FINGERPRINT",
            status: { not: "REJECTED" },
            OR: [{ simhashBand0: b0 }, { simhashBand1: b1 }, { simhashBand2: b2 }, { simhashBand3: b3 }],
          },
          take: 50,
          orderBy: { distinctReporters: "desc" },
        });
        const near = candidates.find((c) => c.simhash && hammingDistance(BigInt(`0x${c.simhash}`), sh) <= NEAR_DUPLICATE_MAX_DISTANCE);
        if (near) match = { p: near, near: true };
      }
      if (!match) return null;
      const { p, near } = match;
      const qualifies = p.status === "TRUSTED" || p.distinctReporters >= MIN_DISTINCT_REPORTERS;
      return {
        knownPattern: qualifies,
        reportCount: p.reportCount,
        distinctReporters: p.distinctReporters,
        confidence: qualifies ? patternConfidence(p.distinctReporters, p.status) : 0,
        category: toCategory(p.category),
        nearDuplicate: near,
      };
    } catch (error) {
      logger.warn("intel_lookup_failed", { error });
      return null;
    }
  },

  domainReputation: {
    name: "internal-reports",
    isAvailable: () => isDatabaseConfigured(),
    async lookup(domains: string[]): Promise<DomainReputation[]> {
      if (!isDatabaseConfigured() || domains.length === 0) return [];
      const [rows, records] = await Promise.all([
        prisma.scamPattern.findMany({
          where: { patternType: "DOMAIN", value: { in: domains.slice(0, 20) }, status: { not: "REJECTED" } },
          take: 20,
        }),
        intelDomainReputation(domains),
      ]);
      return [
        ...records,
        ...rows
        .filter((r) => r.status === "TRUSTED" || r.distinctReporters >= MIN_DISTINCT_REPORTERS)
        .map((r) => ({
          status: (r.status === "TRUSTED" ? "confirmed_malicious" : "suspicious") as DomainReputation["status"],
          domain: r.value,
          maliciousConfidence: patternConfidence(r.distinctReporters, r.status),
          source: "internal-reports",
          lastUpdated: r.lastSeen.toISOString(),
          detail:
            r.status === "TRUSTED"
              ? "This domain is in ScamShield's verified scam list"
              : `This domain was reported as a scam by ${r.distinctReporters} ScamShield users`,
        })),
      ];
    },
  },
};

export function intelSignal(match: PatternMatch | null): RuleSignal[] {
  if (!match?.knownPattern || match.confidence <= 0) return [];
  return [
    {
      ruleId: "intel.known_pattern",
      category: match.category,
      severity: match.confidence >= 0.6 ? "high" : "medium",
      weight: Number((0.5 * match.confidence).toFixed(3)),
      evidence: `${match.nearDuplicate ? "Very similar to" : "Matches"} a message reported by ${match.distinctReporters} users`,
      description: `${match.nearDuplicate ? "Closely resembles" : "Matches"} a scam reported by other ScamShield users.`,
    },
  ];
}
