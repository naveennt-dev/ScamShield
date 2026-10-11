import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";
import { z } from "zod";
import { prisma, isDatabaseConfigured } from "@/lib/db/prisma";
import { logger } from "@/lib/observability/logger";
import { maskSensitiveText } from "@/lib/observability/redact";
import { SCAM_CATEGORIES } from "@/lib/schemas/analysis";
import type { DomainReputation } from "@/lib/url/types";

/**
 * Phase 5 — provenance-aware URL/domain intelligence (`scam_intel`).
 *
 * Rules enforced here (not just documented):
 *  - Sources are kept apart: one row per (kind, key, sourceType). A user report never overwrites
 *    an imported or verified finding and vice versa.
 *  - Status ceilings by source: USER_REPORT and LOCAL_RULE can say at most SUSPICIOUS (or BENIGN);
 *    only IMPORTED_PUBLIC (an operator-chosen list) and VERIFIED (manual review) may say
 *    CONFIRMED_MALICIOUS. There is no LLM source at all — model output never becomes intelligence.
 *  - Keys are normalised: DOMAIN → registrable domain in lower-case ASCII/punycode
 *    (`login.sbi.attacker.test` → `attacker.test`); URL → SHA-256 of the URL without query/fragment.
 *    Raw URLs, message text, OTPs, tokens etc. are never stored; explanations are masked.
 *  - All access goes through Prisma (parameterised); inputs are Zod-validated.
 *  - Expired rows are ignored by lookups and can be pruned.
 */

export const INTEL_KINDS = ["DOMAIN", "URL"] as const;
export const INTEL_STATUSES = ["UNKNOWN", "SUSPICIOUS", "CONFIRMED_MALICIOUS", "BENIGN"] as const;
export const INTEL_SOURCES = ["USER_REPORT", "LOCAL_RULE", "IMPORTED_PUBLIC", "VERIFIED"] as const;
export type IntelKind = (typeof INTEL_KINDS)[number];
export type IntelStatus = (typeof INTEL_STATUSES)[number];
export type IntelSource = (typeof INTEL_SOURCES)[number];

/** Highest confidence each source may claim. */
const CONFIDENCE_CAP: Record<IntelSource, number> = { USER_REPORT: 0.5, LOCAL_RULE: 0.5, IMPORTED_PUBLIC: 0.9, VERIFIED: 0.98 };
/** Sources allowed to state CONFIRMED_MALICIOUS. */
const MAY_CONFIRM: ReadonlySet<IntelSource> = new Set(["IMPORTED_PUBLIC", "VERIFIED"]);

export class IntelValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid intelligence record: ${issues.join("; ")}`);
    this.name = "IntelValidationError";
  }
}

/** Registrable domain in lower-case ASCII (punycode), or null if the input isn't a public domain. */
export function normalizeDomainKey(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host || host.length > 2048) return null;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (!host || isIP(host.replace(/^\[|\]$/g, ""))) return null;
  const ascii = domainToASCII(host);
  if (!ascii) return null;
  // Same parsing as the URL analyser (tldts defaults), so intelligence keys always match the
  // `registrableDomain` the analyser reports — including for non-ICANN suffixes.
  const info = parseDomain(ascii);
  if (!info.domain || info.isIp || !info.publicSuffix || info.domain === info.publicSuffix) return null;
  return info.domain;
}

/** SHA-256 of the normalised URL without query string or fragment (tokens are never hashed in). */
export function urlFingerprint(input: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `http://${input.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = domainToASCII(u.hostname) || u.hostname;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return createHash("sha256").update(`${host}${u.port ? `:${u.port}` : ""}${path}`).digest("hex");
}

const SourceName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w .:@/+-]+$/, "may contain only letters, digits, spaces and . _ : @ / + -");

export const IntelInputSchema = z
  .object({
    kind: z.enum(INTEL_KINDS),
    value: z.string().trim().min(1).max(2048),
    sourceType: z.enum(INTEL_SOURCES),
    status: z.enum(INTEL_STATUSES),
    category: z.enum(SCAM_CATEGORIES).default("other"),
    confidence: z.number().min(0).max(1),
    explanation: z.string().trim().max(300).default(""),
    sourceName: SourceName,
    updateMethod: z.enum(["import", "report", "rule", "manual-review"]),
    reviewAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();
export type IntelInput = z.input<typeof IntelInputSchema>;

export interface PreparedRecord {
  kind: IntelKind;
  key: string;
  sourceType: IntelSource;
  status: IntelStatus;
  category: string;
  confidence: number;
  explanation: string;
  sourceName: string;
  updateMethod: string;
  reviewAt: Date | null;
  expiresAt: Date | null;
  /** Adjustments the policy made (e.g. "CONFIRMED_MALICIOUS not allowed for USER_REPORT"). */
  notes: string[];
}

/** Validate + normalise + apply source policy. Throws IntelValidationError. Pure (no DB). */
export function prepareIntelRecord(input: unknown): PreparedRecord {
  const parsed = IntelInputSchema.safeParse(input);
  if (!parsed.success) throw new IntelValidationError(parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`));
  const r = parsed.data;
  const key = r.kind === "DOMAIN" ? normalizeDomainKey(r.value) : urlFingerprint(r.value);
  if (!key) throw new IntelValidationError([`value: not a valid public ${r.kind === "DOMAIN" ? "domain" : "http(s) URL"}`]);
  if (r.expiresAt && r.expiresAt.getTime() <= Date.now()) throw new IntelValidationError(["expiresAt: must be in the future"]);

  const notes: string[] = [];
  let status = r.status;
  if (status === "CONFIRMED_MALICIOUS" && !MAY_CONFIRM.has(r.sourceType)) {
    status = "SUSPICIOUS";
    notes.push(`${r.sourceType} cannot confirm a domain as malicious; stored as SUSPICIOUS`);
  }
  let confidence = r.confidence;
  if (confidence > CONFIDENCE_CAP[r.sourceType]) {
    confidence = CONFIDENCE_CAP[r.sourceType];
    notes.push(`confidence capped at ${confidence} for ${r.sourceType}`);
  }
  const explanation = maskSensitiveText(r.explanation.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 300);
  return {
    kind: r.kind,
    key,
    sourceType: r.sourceType,
    status,
    category: r.category,
    confidence,
    explanation,
    sourceName: r.sourceName,
    updateMethod: r.updateMethod,
    reviewAt: r.reviewAt ?? null,
    expiresAt: r.expiresAt ?? null,
    notes,
  };
}

export interface UpsertResult {
  id: string;
  created: boolean;
  record: PreparedRecord;
}

/** Insert or merge (same kind+key+source → one row; observations accumulate). */
export async function upsertIntelRecord(input: unknown): Promise<UpsertResult> {
  const rec = prepareIntelRecord(input);
  const where = { kind_key_sourceType: { kind: rec.kind, key: rec.key, sourceType: rec.sourceType } };
  const existing = await prisma.intelRecord.findUnique({ where, select: { id: true } });
  const data = {
    status: rec.status,
    category: rec.category,
    confidence: rec.confidence,
    explanation: rec.explanation,
    sourceName: rec.sourceName,
    updateMethod: rec.updateMethod,
    reviewAt: rec.reviewAt,
    expiresAt: rec.expiresAt,
  };
  const row = await prisma.intelRecord.upsert({
    where,
    create: { kind: rec.kind, key: rec.key, sourceType: rec.sourceType, ...data },
    update: { ...data, observations: { increment: 1 }, lastSeen: new Date() },
    select: { id: true },
  });
  return { id: row.id, created: !existing, record: rec };
}

export async function deleteExpiredIntel(now = new Date()): Promise<number> {
  const r = await prisma.intelRecord.deleteMany({ where: { expiresAt: { lt: now } } });
  return r.count;
}

const STATUS_RANK: Record<IntelStatus, number> = { UNKNOWN: 0, BENIGN: 1, SUSPICIOUS: 2, CONFIRMED_MALICIOUS: 3 };

/**
 * Reputation for registrable domains from non-expired records. BENIGN-only domains produce no
 * risk (and never suppress rule/URL signals elsewhere); unknown domains produce nothing.
 */
export async function intelDomainReputation(domains: string[], now = new Date()): Promise<DomainReputation[]> {
  if (!isDatabaseConfigured() || domains.length === 0) return [];
  const keys = [...new Set(domains.map((d) => normalizeDomainKey(d)).filter((d): d is string => Boolean(d)))].slice(0, 20);
  if (keys.length === 0) return [];
  try {
    const rows = await prisma.intelRecord.findMany({
      where: { kind: "DOMAIN", key: { in: keys }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      take: 200,
    });
    const out: DomainReputation[] = [];
    for (const key of keys) {
      const mine = rows.filter((r) => r.key === key && r.status !== "UNKNOWN");
      if (mine.length === 0) continue;
      const top = mine.reduce((a, b) => (STATUS_RANK[b.status] > STATUS_RANK[a.status] || (b.status === a.status && b.confidence > a.confidence) ? b : a));
      if (top.status === "BENIGN") {
        out.push({ domain: key, maliciousConfidence: 0, source: "scam-intel", detail: "Reported as legitimate (not a risk signal)", status: "benign_reports", lastUpdated: top.lastSeen.toISOString() });
        continue;
      }
      const confirmed = top.status === "CONFIRMED_MALICIOUS";
      out.push({
        domain: key,
        maliciousConfidence: confirmed ? top.confidence : Math.min(0.5, top.confidence),
        source: "scam-intel",
        status: confirmed ? "confirmed_malicious" : "suspicious",
        lastUpdated: top.lastSeen.toISOString(),
        detail: confirmed
          ? `Listed as malicious in ScamShield's local intelligence (${top.sourceType === "VERIFIED" ? "verified" : "imported list"})`
          : `Flagged as suspicious in ScamShield's local intelligence (${top.sourceType === "USER_REPORT" ? "user reports" : "local findings"}; not confirmed)`,
      });
    }
    return out;
  } catch (error) {
    // Rethrown so the URL result says "not checked" instead of implying a clean record.
    logger.warn("intel_records_lookup_failed", { error });
    throw error;
  }
}
