import type { Classification, RiskLevel } from "@/lib/schemas/analysis";

/**
 * Score → level mapping. Shared by server and UI (no server-only imports).
 *
 * Defaults: 0–29 safe · 30–59 suspicious · 60–84 high risk · 85–100 critical; "scam" from HIGH.
 * Configurable via RISK_THRESHOLD_SUSPICIOUS / _HIGH / _CRITICAL. These are hand-chosen starting
 * points, NOT calibrated optima — tune them on validation data (docs/detection/rules.md).
 */
export interface RiskThresholds {
  suspicious: number;
  high: number;
  critical: number;
}

export const THRESHOLDS: RiskThresholds = {
  suspicious: 30,
  high: 60,
  critical: 85,
};

export function validThresholds(t: RiskThresholds): boolean {
  return 0 < t.suspicious && t.suspicious < t.high && t.high < t.critical && t.critical <= 100;
}

export function riskLevelFor(score: number, t: RiskThresholds = THRESHOLDS): RiskLevel {
  if (score >= t.critical) return "critical";
  if (score >= t.high) return "high";
  if (score >= t.suspicious) return "suspicious";
  return "safe";
}

export function classificationFor(score: number, t: RiskThresholds = THRESHOLDS): Classification {
  if (score >= t.high) return "scam";
  if (score >= t.suspicious) return "suspicious";
  return "safe";
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, Number(n.toFixed(3))));
}
