import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { fingerprint } from "@/lib/detection/fingerprint";
import { preprocess } from "@/lib/detection/preprocess";
import { runRules } from "@/lib/detection/rule-engine";
import { maskSensitiveText } from "@/lib/observability/redact";

/**
 * Ingestion of opt-in contributions (a user's feedback on a result, with the masked text).
 *
 * Defences, in order: schema validation and size limits → masking again on the server (the device
 * masks first; never trust it) with link paths dropped → automatic flags (prompt-injection text; a
 * "safe" label on a message that asks for an OTP/PIN/password — a typical poisoning attempt) →
 * one row per (content, contributor): changing your mind updates it, repeats don't add weight →
 * every row starts QUARANTINED. Nothing here touches a model; curation decides what may be used.
 */

export const VERDICTS = ["correct", "missed_scam", "false_positive", "unsure"] as const;
export const SYSTEM_LEVELS = ["safe", "suspicious", "high", "critical"] as const;

export const ContributionSchema = z
  .object({
    installationId: z.string().uuid(),
    text: z.string().trim().min(10).max(2000),
    verdict: z.enum(VERDICTS),
    system: z.object({
      riskLevel: z.enum(SYSTEM_LEVELS),
      riskScore: z.number().int().min(0).max(100),
      category: z.string().max(40).regex(/^[a-z_]+$/).optional(),
    }),
    appVersion: z.string().max(40).regex(/^[\w.+-]+$/),
    modelBuild: z.string().max(80).regex(/^[\w.+-]+$/).optional(),
  })
  .strict();
export type ContributionInput = z.infer<typeof ContributionSchema>;

/** Training label implied by the feedback: what the message actually was. */
export function labelFor(verdict: ContributionInput["verdict"], systemLevel: ContributionInput["system"]["riskLevel"]): "scam" | "safe" | null {
  switch (verdict) {
    case "missed_scam": return "scam";
    case "false_positive": return "safe";
    case "correct": return systemLevel === "safe" ? "safe" : "scam";
    case "unsure": return null;
  }
}

/** Server-side masking: everything maskSensitiveText removes, plus link paths (host kept). */
export function maskForContribution(text: string): string {
  return maskSensitiveText(text)
    .replace(/\b(https?:\/\/[^\s/?#<>"']+)[^\s<>"']*/gi, "$1/…")
    .replace(/\b((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\/[^\s<>"']+/gi, "$1/…")
    .slice(0, 2000);
}

export function contributionFlags(text: string, label: "scam" | "safe" | null): string[] {
  const rules = runRules(preprocess(text));
  const flags: string[] = [];
  if (rules.promptInjectionDetected) flags.push("prompt_injection");
  if (label === "safe" && rules.hasCriticalIndicator) flags.push("safe_label_on_critical_request");
  return flags;
}

const LEVEL_DB = { safe: "SAFE", suspicious: "SUSPICIOUS", high: "HIGH", critical: "CRITICAL" } as const;

export async function recordContribution(input: ContributionInput): Promise<{ id: string; status: string; duplicate: boolean }> {
  const text = maskForContribution(input.text);
  const label = labelFor(input.verdict, input.system.riskLevel);
  const fp = fingerprint(preprocess(text).normalized);
  const contributorHash = createHash("sha256").update(`scamshield-contributor:${input.installationId}`).digest("hex");
  const data = {
    text,
    verdict: input.verdict,
    label,
    systemLevel: LEVEL_DB[input.system.riskLevel],
    systemScore: input.system.riskScore,
    category: input.system.category ?? null,
    appVersion: input.appVersion,
    modelBuild: input.modelBuild ?? null,
    flags: contributionFlags(text, label),
  };
  const existing = await prisma.contribution.findUnique({ where: { fingerprint_contributorHash: { fingerprint: fp, contributorHash } }, select: { id: true } });
  const row = await prisma.contribution.upsert({
    where: { fingerprint_contributorHash: { fingerprint: fp, contributorHash } },
    create: { fingerprint: fp, contributorHash, ...data },
    // A changed mind replaces the verdict and goes back to quarantine for re-curation.
    update: { ...data, status: "QUARANTINED" },
    select: { id: true, status: true },
  });
  return { id: row.id, status: row.status, duplicate: existing !== null };
}
