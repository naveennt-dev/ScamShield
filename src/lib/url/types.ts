import type { Severity, UrlFinding } from "@/lib/schemas/analysis";

export interface ExtractedUrl {
  /** Normalised absolute URL (scheme added for bare domains). */
  url: string;
  /** Exactly as it appeared in the text (after refanging), truncated. */
  raw: string;
  /** True when the text had no scheme (e.g. "sbi-kyc.xyz/login"). */
  bare: boolean;
  /** True when the link was written in an obfuscated ("defanged") form, e.g. example[.]com, hxxp://. */
  obfuscated?: boolean;
}

export interface UrlFlag {
  id: string;
  severity: Severity;
  weight: number;
  detail: string;
}

export type { UrlFinding };

export interface DomainReputation {
  domain: string;
  /** 0–1: how strongly the source believes the domain is malicious. */
  maliciousConfidence: number;
  source: string;
  detail: string;
  /** Reputation class; absent = treated as "suspicious" for legacy providers. */
  status?: "suspicious" | "confirmed_malicious" | "benign_reports";
  /** ISO time the source last saw/updated this record. */
  lastUpdated?: string;
}

/**
 * Integration point for reputation feeds. Built in: ScamShield's own intelligence database
 * ("internal-reports"). An external feed (e.g. a threat-intelligence API) plugs in here; none is
 * configured by default and none is bundled — see docs/design/shared-learning-and-url-intelligence.md.
 *
 * Contract: `lookup` resolves with the records it has (an empty list = "checked, nothing known")
 * and REJECTS when it could not check. `isAvailable() === false` means it was not consulted.
 */
export interface DomainReputationProvider {
  readonly name: string;
  isAvailable?(): boolean;
  lookup(domains: string[]): Promise<DomainReputation[]>;
}
