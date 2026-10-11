import type { ScamCategory } from "@/lib/schemas/analysis";
import type { PreprocessedText } from "./preprocess";
import { COMBOS, CRITICAL_RULES, RULES } from "./rules";
import { asksReaderToAct, isAwarenessText } from "./rules/context";
import type { RuleDefinition, RuleEngineResult, RuleSignal } from "./types";

/**
 * Rule engine: evaluates every rule, adds combo signals, and combines weights with a noisy-OR:
 *   score = 100 × (1 − Π(1 − wᵢ))
 * so independent indicators accumulate with diminishing returns and never exceed 100.
 */

const SEVERITY_CONFIDENCE = { low: 0.15, medium: 0.3, high: 0.5 } as const;

function matchesGroup(firedIds: Set<string>, group: string[]): boolean {
  return group.some((g) => (g.endsWith(".") ? [...firedIds].some((id) => id.startsWith(g)) : firedIds.has(g)));
}

export function runRules(
  text: PreprocessedText,
  extraSignals: RuleSignal[] = [],
  rules: RuleDefinition[] = RULES,
): RuleEngineResult {
  const hostnames = text.urls
    .map((u) => {
      try {
        return new URL(u.url).hostname.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const ctx = { text, hostnames };

  // Safety tips and news ABOUT scams ask the reader for nothing: only the link and
  // prompt-injection checks still apply to them (rules/context.ts).
  const awareness = isAwarenessText(text.lower);
  const active = awareness ? rules.filter((r) => r.id.startsWith("link.") || r.id.startsWith("adversarial.")) : rules;

  const signals: RuleSignal[] = [];
  let failedRules = 0;
  for (const r of active) {
    let evidence: string | null = null;
    try {
      evidence = r.evaluate(ctx);
    } catch {
      evidence = null; // a faulty rule must never break analysis…
      failedRules++; // …but it is counted, so a "nothing found" can't hide it
    }
    if (evidence !== null) {
      signals.push({
        ruleId: r.id,
        category: r.category,
        severity: r.severity,
        evidence,
        weight: r.weight,
        description: r.description,
      });
    }
  }
  signals.push(...extraSignals);

  const fired = new Set(signals.map((s) => s.ruleId));
  for (const combo of COMBOS) {
    if (combo.requires.every((g) => matchesGroup(fired, g))) {
      const members = signals.filter((s) => combo.requires.some((g) => matchesGroup(new Set([s.ruleId]), g)));
      const category =
        combo.category ??
        members.find((m) => m.category !== "other" && m.category !== "phishing")?.category ??
        members[0]?.category ??
        "other";
      signals.push({
        ruleId: combo.id,
        category,
        severity: combo.severity,
        evidence: members.map((m) => m.ruleId).join(" + "),
        weight: combo.weight,
        description: combo.description,
      });
    }
  }

  const score = Math.round(100 * (1 - signals.reduce((acc, s) => acc * (1 - Math.min(0.95, s.weight)), 1)));

  // Confidence: deterministic rules are precise when they fire; absence of rules is weak
  // evidence of safety (rules have limited recall), hence the 0.35 floor-ish baseline.
  const confidence =
    signals.length === 0
      ? 0.35
      : Math.min(0.95, 0.4 + signals.reduce((acc, s) => acc + SEVERITY_CONFIDENCE[s.severity], 0) * 0.5);

  const categoryScores: Partial<Record<ScamCategory, number>> = {};
  for (const s of signals) {
    if (s.category === "other") continue;
    categoryScores[s.category] = (categoryScores[s.category] ?? 0) + s.weight;
  }
  // Prefer specific categories over generic "phishing"/"credential_theft" when both are present.
  const ranked = (Object.entries(categoryScores) as Array<[ScamCategory, number]>).sort((a, b) => {
    const generic = (c: ScamCategory) => (c === "phishing" || c === "credential_theft" ? 1 : 0);
    return b[1] - generic(b[0]) * 0.2 - (a[1] - generic(a[0]) * 0.2);
  });

  return {
    signals,
    score,
    confidence,
    categoryScores,
    topCategory: ranked[0]?.[0] ?? null,
    promptInjectionDetected: fired.has("adversarial.prompt_injection"),
    hasCriticalIndicator: signals.some((s) => CRITICAL_RULES.has(s.ruleId)),
    awareness,
    asksReaderToAct: asksReaderToAct(text.lower),
    failedRules,
  };
}
