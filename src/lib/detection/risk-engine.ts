import type { FusionAdjustment, ScamCategory, SignalContribution, SignalSource } from "@/lib/schemas/analysis";
import { clampConfidence, clampScore, classificationFor, riskLevelFor, THRESHOLDS, type RiskThresholds } from "./thresholds";
import type { FusionInput, FusionResult, FusionWeights, SourceSignal } from "./types";

/**
 * Risk Fusion Engine.
 *
 * 1. Confidence-weighted mean over AVAILABLE sources:
 *      wᵢ = configuredWeightᵢ × confidenceᵢ   (ML from a seed model is halved)
 *      base = Σ wᵢ·scoreᵢ / Σ wᵢ
 *    Unavailable sources (LLM down, no URLs, ML missing) drop out and the rest renormalise.
 * 2. Safety guards, each recorded as an explicit adjustment:
 *    - Deterministic floor: final ≥ 0.8 × max(rule score, URL score). Rules/URL heuristics are
 *      precise when they fire; no other model may argue them away.
 *    - Critical-indicator floor: an OTP/PIN/CVV/password/remote-access/APK request keeps the
 *      result at least SUSPICIOUS.
 *    - Prompt-injection guard: if the content tries to instruct an AI, an LLM verdict that is
 *      lower than the deterministic baseline is discarded, and the result is at least SUSPICIOUS.
 *    - Corroboration boost: when ≥2 independent sources say ≥ HIGH, the result is at least the
 *      second-highest of those scores.
 * 3. Remote-never-lowers (Phase 4): the result WITH the remote LLM is never below the result the
 *    local sources (rules + ML + URL) produce on their own. The LLM is untrusted supplementary
 *    evidence — a wrong or manipulated "safe" can't reduce a local warning, and a remote failure
 *    (LLM absent) trivially leaves the local score unchanged. It CAN raise the score, within the
 *    uncorroborated cap below.
 * 4. Uncorroborated-ML cap (options.capUncorroboratedMl, default on): if NO rule fired and no link
 *    scored HIGH, the ML/LLM signals alone can raise the result to at most SUSPICIOUS (high − 1).
 *    The baseline model is weak on the scam domain (docs/ml/evaluation.md), so it may warn but not
 *    raise a HIGH-RISK alarm without deterministic evidence.
 * 5. Nothing-asked gate: with no rule and no risky link, if the text asks the reader to do nothing
 *    a scam needs (no link, number, payment, details, install) or is a safety tip / news ABOUT
 *    scams, the ML model alone can't make it SUSPICIOUS — it stays low risk, with the reason shown.
 *    Not applied when the remote AI gave a usable verdict (that verdict stays capped by rule 4).
 */

export interface FusionOptions {
  capUncorroboratedMl?: boolean;
}

export const DEFAULT_WEIGHTS: FusionWeights = { ml: 0.35, rules: 0.3, url: 0.2, llm: 0.15 };

const SOURCES: SignalSource[] = ["rules", "ml", "url", "llm"];

export function fuseRisk(
  input: FusionInput,
  weights: FusionWeights = DEFAULT_WEIGHTS,
  thresholds: RiskThresholds = THRESHOLDS,
  options: FusionOptions = {},
): FusionResult {
  const T = thresholds;
  const adjustments: FusionAdjustment[] = [];
  const notes: Partial<Record<SignalSource, string>> = {};

  const signals: Record<SignalSource, SourceSignal | null> = {
    rules: input.rules,
    ml: input.ml,
    url: input.url,
    llm: input.llm,
  };

  const deterministicBaseline = Math.max(input.rules.score, input.url?.available ? input.url.score : 0);

  // Prompt-injection guard on the LLM signal.
  let llmUsable = Boolean(input.llm?.available);
  if (input.rules.promptInjectionDetected && input.llm?.available && input.llm.score < deterministicBaseline) {
    llmUsable = false;
    notes.llm = "Ignored: content attempted to instruct the AI and the AI rated it lower than deterministic checks";
  }

  const effective: Record<SignalSource, number> = { rules: 0, ml: 0, url: 0, llm: 0 };
  for (const src of SOURCES) {
    const s = signals[src];
    if (!s?.available) continue;
    if (src === "llm" && !llmUsable) continue;
    let conf = s.confidence;
    if (src === "ml" && input.ml?.seedModel) {
      conf *= 0.5;
      notes.ml = "Seed model (trained on illustrative data) — weight halved";
    }
    effective[src] = Math.max(0, weights[src]) * Math.max(0, Math.min(1, conf));
  }

  const totalW = SOURCES.reduce((a, s) => a + effective[s], 0);
  const base =
    totalW > 0 ? SOURCES.reduce((a, s) => a + effective[s] * (signals[s]?.score ?? 0), 0) / totalW : input.rules.score;
  let score = base;

  const apply = (kind: FusionAdjustment["kind"], to: number, reason: string) => {
    if (to > score) {
      adjustments.push({ kind, reason, from: clampScore(score), to: clampScore(to) });
      score = to;
    }
  };

  // Local-only result (same inputs, no LLM): the remote verdict may add, never subtract.
  if (llmUsable) {
    const local = fuseRisk({ ...input, llm: null }, weights, thresholds, options);
    if (score < local.riskScore) {
      adjustments.push({
        kind: "floor",
        reason: "Remote AI can add evidence but never lowers the on-device result",
        from: clampScore(score),
        to: local.riskScore,
      });
      score = local.riskScore;
    }
  }

  const floor = 0.8 * deterministicBaseline;
  apply("floor", floor, "Deterministic rule/URL evidence sets a minimum score");

  if (input.rules.hasCriticalIndicator) {
    apply("floor", T.suspicious + 15, "Requests something no legitimate sender asks for (OTP/PIN/CVV/password/remote access/app install)");
  }
  if (input.rules.promptInjectionDetected) {
    apply("floor", T.suspicious, "Content contains instructions aimed at AI systems (manipulation attempt)");
  }

  const highScores = SOURCES.filter((s) => (s !== "llm" || llmUsable) && signals[s]?.available)
    .map((s) => signals[s]!.score)
    .filter((v) => v >= T.high)
    .sort((a, b) => b - a);
  if (highScores.length >= 2) {
    apply("boost", highScores[1], "Multiple independent detectors agree this is high risk");
  }

  const corroborated = input.rules.signalCount > 0 || Boolean(input.url?.available && input.url.score >= T.high);
  if ((options.capUncorroboratedMl ?? true) && !corroborated && score >= T.high) {
    const to = T.high - 1;
    adjustments.push({ kind: "cap", reason: "Only the ML/AI model flagged this; without a matching safety rule or risky link it is shown as suspicious, not high risk", from: clampScore(score), to });
    score = to;
  }

  const asksNothing = input.rules.asksReaderToAct === false || input.rules.awareness === true;
  if ((options.capUncorroboratedMl ?? true) && !corroborated && !llmUsable && asksNothing && score >= T.suspicious) {
    const to = T.suspicious - 1;
    adjustments.push({
      kind: "cap",
      reason: input.rules.awareness
        ? "Reads as a safety tip or news about scams, and asks you for nothing — the ML model's score alone isn't treated as a warning"
        : "Only the ML model found this unusual, and the message asks you to do nothing risky (no link, number, payment or details) — shown as low risk",
      from: clampScore(score),
      to,
    });
    score = to;
  }

  const riskScore = clampScore(score);

  // Confidence: average source confidence, reduced by disagreement with the final score.
  const usedSources = SOURCES.filter((s) => effective[s] > 0);
  const avgConf =
    usedSources.length > 0
      ? usedSources.reduce((a, s) => a + effective[s] * signals[s]!.confidence, 0) / usedSources.reduce((a, s) => a + effective[s], 0)
      : 0.3;
  const disagreement =
    usedSources.length > 0
      ? usedSources.reduce((a, s) => a + effective[s] * Math.abs(signals[s]!.score - riskScore), 0) /
        usedSources.reduce((a, s) => a + effective[s], 0) /
        100
      : 0.5;
  // Fewer sources ⇒ less corroboration.
  const coverage = Math.min(1, 0.55 + 0.15 * usedSources.length);
  let confidence = avgConf * (1 - 0.6 * disagreement) * coverage;
  if (adjustments.some((a) => a.kind === "floor") && input.rules.signalCount > 0) {
    confidence = Math.max(confidence, Math.min(0.9, input.rules.confidence));
  }

  const contributions: SignalContribution[] = SOURCES.map((src) => {
    const s = signals[src];
    const ew = totalW > 0 ? effective[src] / totalW : 0;
    return {
      source: src,
      available: Boolean(s?.available),
      score: s?.available ? clampScore(s.score) : null,
      confidence: s?.available ? clampConfidence(s.confidence) : null,
      configuredWeight: clampConfidence(weights[src]),
      effectiveWeight: clampConfidence(ew),
      contribution: Number((ew * (s?.score ?? 0)).toFixed(2)),
      note: notes[src] ?? s?.note,
    };
  });

  return {
    riskScore,
    confidence: clampConfidence(confidence),
    classification: classificationFor(riskScore, T),
    riskLevel: riskLevelFor(riskScore, T),
    category: pickCategory(input, effective, riskScore, T),
    contributions,
    adjustments,
  };
}

function pickCategory(input: FusionInput, effective: Record<SignalSource, number>, riskScore: number, T: RiskThresholds): ScamCategory {
  if (riskScore < T.suspicious) return "other";
  const votes = new Map<ScamCategory, number>();
  const add = (c: ScamCategory | null | undefined, v: number) => {
    if (!c || c === "other" || v <= 0) return;
    votes.set(c, (votes.get(c) ?? 0) + v);
  };

  const ruleTotal = Object.values(input.rules.categoryScores).reduce((a, b) => a + (b ?? 0), 0);
  if (ruleTotal > 0) {
    // Rules get a minimum say in the category even when their score weight is small: they
    // explain *what kind* of scam with high precision.
    const ruleWeight = Math.max(effective.rules, 0.15);
    for (const [c, v] of Object.entries(input.rules.categoryScores)) add(c as ScamCategory, ruleWeight * ((v ?? 0) / ruleTotal));
  }
  if (input.ml?.available && input.ml.categoryProba) {
    for (const [c, p] of Object.entries(input.ml.categoryProba)) add(c as ScamCategory, effective.ml * p * 0.8);
  }
  if (input.llm?.available && effective.llm > 0) add(input.llm.category, effective.llm * 1.2);
  if (input.url?.available && input.url.score >= T.high) add("phishing", effective.url * 0.5);

  const generic = new Set<ScamCategory>(["phishing", "credential_theft"]);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "other";
  // Prefer a specific category if it is within 25% of a generic winner.
  if (generic.has(ranked[0][0])) {
    const specific = ranked.find(([c]) => !generic.has(c));
    if (specific && specific[1] >= ranked[0][1] * 0.75) return specific[0];
  }
  return ranked[0][0];
}
