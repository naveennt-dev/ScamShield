import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, fuseRisk } from "@/lib/detection/risk-engine";
import { classificationFor, riskLevelFor, THRESHOLDS } from "@/lib/detection/thresholds";
import type { FusionInput } from "@/lib/detection/types";
import type { ScamCategory } from "@/lib/schemas/analysis";

const rules = (score: number, extra: Partial<FusionInput["rules"]> = {}): FusionInput["rules"] => ({
  available: true,
  score,
  confidence: score > 0 ? 0.8 : 0.35,
  hasCriticalIndicator: false,
  promptInjectionDetected: false,
  signalCount: score > 0 ? 2 : 0,
  categoryScores: score > 0 ? { kyc: 0.5 } : {},
  ...extra,
});
const ml = (score: number, seedModel = false): FusionInput["ml"] => ({
  available: true,
  score,
  confidence: 0.8,
  category: "kyc",
  categoryProba: { kyc: 0.9, other: 0.1 },
  seedModel,
});
const llm = (score: number, category: ScamCategory = "other"): FusionInput["llm"] => ({
  available: true,
  score,
  confidence: 0.9,
  category,
  classification: score >= 60 ? "scam" : score >= 30 ? "suspicious" : "safe",
});

describe("thresholds", () => {
  it("maps scores to levels and classifications", () => {
    expect(riskLevelFor(0)).toBe("safe");
    expect(riskLevelFor(THRESHOLDS.suspicious)).toBe("suspicious");
    expect(riskLevelFor(THRESHOLDS.high)).toBe("high");
    expect(riskLevelFor(THRESHOLDS.critical)).toBe("critical");
    expect(classificationFor(59)).toBe("suspicious");
    expect(classificationFor(60)).toBe("scam");
  });
});

describe("risk fusion", () => {
  it("keeps scores in range and reports contributions for every source", () => {
    const r = fuseRisk({ rules: rules(50), ml: ml(70), url: { available: true, score: 80, confidence: 0.75 }, llm: llm(90) });
    expect(r.riskScore).toBeGreaterThanOrEqual(0);
    expect(r.riskScore).toBeLessThanOrEqual(100);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.contributions.map((c) => c.source)).toEqual(["rules", "ml", "url", "llm"]);
    const totalWeight = r.contributions.reduce((a, c) => a + c.effectiveWeight, 0);
    expect(totalWeight).toBeCloseTo(1, 2);
  });

  it("renormalises when sources are unavailable", () => {
    const r = fuseRisk({ rules: rules(0), ml: ml(10), url: null, llm: null });
    expect(r.contributions.find((c) => c.source === "url")!.effectiveWeight).toBe(0);
    expect(r.contributions.find((c) => c.source === "llm")!.available).toBe(false);
    expect(r.riskLevel).toBe("safe");
  });

  it("never lets the LLM declare a rule-flagged message safe", () => {
    const r = fuseRisk({ rules: rules(85), ml: ml(20), url: null, llm: llm(0) });
    expect(r.riskScore).toBeGreaterThanOrEqual(0.8 * 85 - 1);
    expect(r.classification).toBe("scam");
    expect(r.adjustments.some((a) => a.kind === "floor")).toBe(true);
  });

  it("keeps critical indicators at least suspicious even if ML and LLM disagree", () => {
    const r = fuseRisk({ rules: rules(30, { hasCriticalIndicator: true }), ml: ml(5), url: null, llm: llm(0) });
    expect(r.riskScore).toBeGreaterThanOrEqual(THRESHOLDS.suspicious);
  });

  it("discards a low LLM verdict when the content attempts prompt injection", () => {
    const r = fuseRisk({ rules: rules(60, { promptInjectionDetected: true }), ml: ml(60), url: null, llm: llm(0) });
    const l = r.contributions.find((c) => c.source === "llm")!;
    expect(l.effectiveWeight).toBe(0);
    expect(l.note).toMatch(/instruct the AI/);
  });

  it("boosts when two independent detectors agree on high risk", () => {
    const r = fuseRisk({ rules: rules(10), ml: ml(90), url: { available: true, score: 80, confidence: 0.75 }, llm: null });
    expect(r.riskScore).toBeGreaterThanOrEqual(80);
    expect(r.adjustments.some((a) => a.kind === "boost")).toBe(true);
  });

  it("halves the weight of a seed ML model", () => {
    const full = fuseRisk({ rules: rules(0), ml: ml(90, false), url: null, llm: null });
    const seed = fuseRisk({ rules: rules(0), ml: ml(90, true), url: null, llm: null });
    expect(seed.riskScore).toBeLessThan(full.riskScore);
  });

  it("an LLM alone cannot push an otherwise clean message into high risk with default weights", () => {
    const r = fuseRisk({ rules: rules(0), ml: ml(10), url: null, llm: llm(95, "phishing") }, DEFAULT_WEIGHTS);
    expect(r.riskScore).toBeLessThan(THRESHOLDS.high);
  });

  it("returns 'other' category for safe results and a specific category otherwise", () => {
    expect(fuseRisk({ rules: rules(0), ml: ml(5), url: null, llm: null }).category).toBe("other");
    expect(fuseRisk({ rules: rules(80), ml: ml(80), url: null, llm: null }).category).toBe("kyc");
  });
});
