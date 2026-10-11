import type { AnalysisResult, FusionAdjustment, Indicator, SignalContribution, UrlFinding } from "@/lib/schemas/analysis";
import type { RiskThresholds } from "./thresholds";

/**
 * "Why is this green / orange / red?" — a factual account of the decision, derived only from what
 * the detectors actually produced (rule matches with the words they matched, the ML model's score,
 * each link's findings, the remote AI's verdict, and every safety adjustment). No canned text is
 * chosen independently of the evidence.
 */

export interface DecisionExplanation {
  colour: "green" | "orange" | "red" | "grey";
  /** One sentence: why this colour, citing the score and thresholds. */
  why: string;
  /** What each source found, in plain language (AI lines are labelled as AI). */
  basis: string[];
  /** Which word(s) in the message triggered each matched rule (masked evidence). */
  matches: { rule: string; text: string; severity: Indicator["severity"] }[];
  thresholds: { suspicious: number; high: number; critical: number };
}

const pct = (n: number) => `${Math.round(n)}`;

export function explainDecision(input: {
  result: Pick<AnalysisResult, "riskLevel" | "riskScore" | "indicators" | "urls" | "remoteAnalysis"> & Partial<Pick<AnalysisResult, "assessment">>;
  signals: SignalContribution[];
  adjustments: FusionAdjustment[];
  ruleDescriptions: Map<string, string>;
  thresholds: RiskThresholds;
}): DecisionExplanation {
  const { result, signals, adjustments, thresholds: T } = input;
  const insufficient = result.assessment?.status === "insufficient";
  const colour = insufficient ? "grey" : result.riskLevel === "safe" ? "green" : result.riskLevel === "suspicious" ? "orange" : "red";
  const sig = (s: SignalContribution["source"]) => signals.find((x) => x.source === s);
  const rules = result.indicators.filter((i) => i.source === "rules" || i.source === "intel" || i.source === "email");
  const strong = rules.filter((r) => r.severity === "high");

  const basis: string[] = [];
  const r = sig("rules");
  basis.push(
    rules.length === 0
      ? "Safety rules: none of the scam patterns matched (OTP/PIN/password requests, payment demands, threats, fake offers, impersonation, risky links)."
      : `Safety rules: ${rules.length} matched (${strong.length} strong), rule score ${pct(r?.score ?? 0)}/100.`,
  );
  const ml = sig("ml");
  basis.push(
    ml?.available && ml.score !== null
      ? `ML model: ${pct(ml.score)}/100 scam-like${ml.score >= 70 ? " (strongly resembles scam messages)" : ml.score >= 40 ? " (uncertain)" : " (resembles normal messages)"} — a model estimate, not proof.`
      : `ML model: not used${ml?.note ? ` (${ml.note})` : " (unavailable)"}.`,
  );
  for (const u of result.urls.slice(0, 3)) basis.push(describeLink(u));
  if (result.urls.length === 0) basis.push("Links: none found.");
  const llm = sig("llm");
  if (result.remoteAnalysis.used && llm?.score !== null && llm?.score !== undefined) {
    basis.push(`AI second opinion: rated ${pct(llm.score)}/100. The AI can raise the risk but never lower the on-device result.`);
  } else if (result.remoteAnalysis.requested) {
    basis.push(`AI second opinion: not used (${result.remoteAnalysis.reason ?? result.remoteAnalysis.status}).`);
  }
  for (const a of adjustments) basis.push(`Safety adjustment: ${a.reason} (${pct(a.from)} → ${pct(a.to)}).`);

  const s = result.riskScore;
  let why: string;
  if (insufficient) {
    why = `Unable to assess: no warning signs were found, but ${result.assessment!.reasons.join(" and ")} — so this is NOT a safe verdict. Check the message yourself or scan again once the service is healthy.`;
  } else if (colour === "red") {
    why = `Red: final score ${s}/100 is at or above the high-risk line (${T.high})${strong.length ? ` — strong evidence: ${strong.slice(0, 2).map((x) => (input.ruleDescriptions.get(x.type) ?? x.type).replace(/\.+$/, "")).join("; ")}` : ""}.`;
  } else if (colour === "orange") {
    why = `Orange: final score ${s}/100 is between the suspicious line (${T.suspicious}) and the high-risk line (${T.high}) — some warning signs, not conclusive.`;
  } else {
    why = rules.length === 0 && (ml?.score ?? 0) < 40
      ? `Green: final score ${s}/100 is below the suspicious line (${T.suspicious}); no scam pattern matched and the ML model rated it as a normal message.`
      : `Green: final score ${s}/100 is below the suspicious line (${T.suspicious}); the signs found are weak on their own — this is low risk, not a guarantee.`;
  }

  return {
    colour,
    why,
    basis,
    matches: rules.slice(0, 6).map((i) => ({ rule: input.ruleDescriptions.get(i.type) ?? i.type, text: i.evidence, severity: i.severity })),
    thresholds: { suspicious: T.suspicious, high: T.high, critical: T.critical },
  };
}

function describeLink(u: UrlFinding): string {
  const status =
    u.reputation === "confirmed_malicious"
      ? "listed as malicious in ScamShield's intelligence"
      : u.reputation === "suspicious"
        ? "reported as suspicious (not confirmed)"
        : u.reputation === "benign_reports"
          ? "reported as legitimate (not a guarantee)"
          : u.intel && !u.intel.checked
            ? "reputation not checked (intelligence database unavailable)"
            : "no record in ScamShield's intelligence (not proof either way)";
  const flags = u.flags.filter((f) => f.severity !== "low").map((f) => f.detail);
  return `Link ${u.hostname || u.url}: risk ${u.riskScore}/100, ${status}${flags.length ? `; ${flags.slice(0, 2).join("; ")}` : ""}.`;
}
