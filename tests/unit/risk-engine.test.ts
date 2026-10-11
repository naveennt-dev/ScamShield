import { describe, expect, it } from "vitest";
import { fuseRisk } from "@/lib/detection/risk-engine";
import { classificationFor, riskLevelFor, THRESHOLDS, validThresholds } from "@/lib/detection/thresholds";
import type { FusionInput } from "@/lib/detection/types";
import type { ScamCategory } from "@/lib/schemas/analysis";

const rules = (score: number, critical = false): FusionInput["rules"] => ({
  available: true,
  score,
  confidence: score > 0 ? 0.85 : 0.35,
  hasCriticalIndicator: critical,
  promptInjectionDetected: false,
  signalCount: score > 0 ? 3 : 0,
  categoryScores: score > 0 ? { kyc: 0.6 } : {},
});
const ml = (score: number, confidence: number, category: ScamCategory | null = null): FusionInput["ml"] => ({
  available: true,
  score,
  confidence,
  category,
  categoryProba: category ? { [category]: 0.9 } : null,
  seedModel: false,
});
const fuse = (r: FusionInput["rules"], m: FusionInput["ml"], url: FusionInput["url"] = null) => fuseRisk({ rules: r, ml: m, url, llm: null });

describe("local risk engine (rules + ML, no LLM)", () => {
  it("safe ML + no rules → safe", () => {
    const r = fuse(rules(0), ml(4, 0.95));
    expect(r.riskLevel).toBe("safe");
    expect(r.classification).toBe("safe");
  });

  it("uncertain ML + strong rules → escalates (ML is not the only safety mechanism)", () => {
    const r = fuse(rules(92, true), ml(35, 0.4));
    expect(r.classification).toBe("scam");
    expect(r.riskScore).toBeGreaterThanOrEqual(0.8 * 92 - 1);
  });

  it("ML confidently SAFE but OTP+PIN+urgent bank rules fire → still escalates", () => {
    const r = fuse(rules(95, true), ml(2, 0.98));
    expect(r.classification).toBe("scam");
    expect(r.adjustments.some((a) => a.kind === "floor")).toBe(true);
  });

  it("scam ML + weak rules → at least suspicious, driven by ML", () => {
    const r = fuse(rules(12), ml(90, 0.9, "investment"));
    expect(r.riskScore).toBeGreaterThanOrEqual(THRESHOLDS.suspicious);
    expect(r.contributions.find((c) => c.source === "ml")!.effectiveWeight).toBeGreaterThan(r.contributions.find((c) => c.source === "rules")!.effectiveWeight);
  });

  it("extreme inputs stay within 0–100 and confidence within 0–1", () => {
    for (const [a, b] of [[0, 0], [100, 100], [100, 0], [0, 100]]) {
      const r = fuse(rules(a, a === 100), ml(b, 1));
      expect(r.riskScore).toBeGreaterThanOrEqual(0);
      expect(r.riskScore).toBeLessThanOrEqual(100);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("ML unavailable → rules-only result, renormalised", () => {
    const r = fuse(rules(70), null);
    expect(r.contributions.find((c) => c.source === "ml")!.available).toBe(false);
    expect(r.contributions.find((c) => c.source === "rules")!.effectiveWeight).toBeCloseTo(1, 5);
    expect(r.classification).toBe("scam");
  });

  it("explains every contribution", () => {
    const r = fuse(rules(60), ml(80, 0.9));
    expect(r.contributions.map((c) => c.source)).toEqual(["rules", "ml", "url", "llm"]);
    expect(r.contributions.reduce((a, c) => a + c.effectiveWeight, 0)).toBeCloseTo(1, 2);
  });
});

describe("thresholds", () => {
  it.each([
    [0, "safe"], [29, "safe"], [30, "suspicious"], [59, "suspicious"], [60, "high"], [84, "high"], [85, "critical"], [100, "critical"],
  ] as const)("default boundary %i → %s", (score, level) => {
    expect(riskLevelFor(score)).toBe(level);
  });

  it("custom thresholds (e.g. 31/61/81) are honoured by the engine", () => {
    const T = { suspicious: 31, high: 61, critical: 81 };
    expect(riskLevelFor(30, T)).toBe("safe");
    expect(riskLevelFor(81, T)).toBe("critical");
    expect(classificationFor(60, T)).toBe("suspicious");
    const r = fuseRisk({ rules: rules(0), ml: ml(60, 1), url: null, llm: null }, undefined, T);
    expect(r.classification).toBe(classificationFor(r.riskScore, T));
  });

  it("validates ordering", () => {
    expect(validThresholds(THRESHOLDS)).toBe(true);
    expect(validThresholds({ suspicious: 60, high: 30, critical: 85 })).toBe(false);
    expect(validThresholds({ suspicious: 0, high: 30, critical: 85 })).toBe(false);
  });
});

describe("uncorroborated-ML cap", () => {
  it("ML alone (no rules, no risky link) can only reach SUSPICIOUS, and the cap is explained", () => {
    const r = fuse(rules(0), ml(95, 0.97));
    expect(r.classification).toBe("suspicious");
    expect(r.riskScore).toBe(THRESHOLDS.high - 1);
    expect(r.adjustments.find((a) => a.kind === "cap")?.reason).toMatch(/Only the ML/);
  });

  it("any rule or a high-risk link lifts the cap", () => {
    expect(fuse(rules(15), ml(95, 0.97)).classification).toBe("scam");
    expect(fuse(rules(0), ml(95, 0.97), { available: true, score: 70, confidence: 0.75 }).classification).toBe("scam");
  });

  it("can be disabled", () => {
    const r = fuseRisk({ rules: rules(0), ml: ml(95, 0.97), url: null, llm: null }, undefined, THRESHOLDS, { capUncorroboratedMl: false });
    expect(r.classification).toBe("scam");
  });
});
