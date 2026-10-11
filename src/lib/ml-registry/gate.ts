import { readFileSync } from "node:fs";
import { EmbeddedClassifier } from "@/lib/detection/ml/classifier";
import { createMlEngine } from "@/lib/detection/ml";
import { runScreenPipeline } from "@/lib/detection/screen";

/**
 * Evaluation gate for a candidate model: the full local detection engine (rules + candidate ML +
 * URL checks; no network) is run on fixed evaluation sets and compared with the active model.
 * A candidate is promotable only if it is no worse on every set — more scams caught or equal,
 * genuine messages flagged fewer or equal (UCI genuine-SMS false-positive rate within +0.3 pts).
 * These sets are synthetic + public UCI SMS: a regression gate, not an accuracy claim.
 */

export const GATE_SETS = [
  "tests/fixtures/eval/realistic-v1.jsonl",
  "tests/fixtures/eval/heldout-v2.jsonl",
  "tests/fixtures/eval/blind-v3.jsonl",
] as const;
export const UCI_TEST = "ml/datasets/processed/test.jsonl";
export const UCI_FPR_TOLERANCE = 0.003;

export interface SetScore {
  set: string;
  scams: number;
  caught: number;
  genuine: number;
  flagged: number;
}

export interface GateReport {
  candidate: { modelPath: string; sets: SetScore[]; uciHamFpr: number };
  active: { modelPath: string; sets: SetScore[]; uciHamFpr: number };
  passed: boolean;
  reasons: string[];
}

async function score(modelPath: string, files: readonly string[]): Promise<{ sets: SetScore[]; uciHamFpr: number }> {
  // Loaded directly: loadEmbeddedClassifier() caches one model per process, whatever the path.
  const classifier = EmbeddedClassifier.fromJson(JSON.parse(readFileSync(modelPath, "utf8")));
  const ml = createMlEngine({ service: null, embedded: async () => classifier });
  const run = async (text: string) =>
    (await runScreenPipeline({ inputType: "message", text, requestId: "gate", allowLlm: false }, { ai: null, intel: null, ml })).result.riskLevel !== "safe";
  const sets: SetScore[] = [];
  for (const set of files) {
    const rows = readFileSync(set, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { label: string; text: string });
    const s: SetScore = { set, scams: 0, caught: 0, genuine: 0, flagged: 0 };
    for (const r of rows) {
      const warned = await run(r.text);
      if (r.label === "scam") { s.scams++; if (warned) s.caught++; }
      else { s.genuine++; if (warned) s.flagged++; }
    }
    sets.push(s);
  }
  const ham = readFileSync(UCI_TEST, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { source: string; text: string }).filter((r) => r.source === "uci-sms-ham");
  let fp = 0;
  for (const r of ham) if (await run(r.text)) fp++;
  return { sets, uciHamFpr: ham.length ? fp / ham.length : 0 };
}

export async function runGate(candidatePath: string, activePath: string, files: readonly string[] = GATE_SETS): Promise<GateReport> {
  const candidate = { modelPath: candidatePath, ...(await score(candidatePath, files)) };
  const active = { modelPath: activePath, ...(await score(activePath, files)) };
  const reasons: string[] = [];
  candidate.sets.forEach((c, i) => {
    const a = active.sets[i];
    if (c.caught < a.caught) reasons.push(`${c.set}: catches fewer scams (${c.caught} < ${a.caught})`);
    if (c.flagged > a.flagged) reasons.push(`${c.set}: flags more genuine messages (${c.flagged} > ${a.flagged})`);
  });
  if (candidate.uciHamFpr > active.uciHamFpr + UCI_FPR_TOLERANCE) {
    reasons.push(`UCI genuine-SMS false-positive rate rose (${(candidate.uciHamFpr * 100).toFixed(2)}% > ${(active.uciHamFpr * 100).toFixed(2)}%)`);
  }
  return { candidate, active, passed: reasons.length === 0, reasons };
}

export function gateSummary(r: GateReport): string {
  const rows = r.candidate.sets.map((c, i) => {
    const a = r.active.sets[i];
    return `| ${c.set.split("/").pop()} | ${a.caught}/${a.scams} | ${c.caught}/${c.scams} | ${a.flagged}/${a.genuine} | ${c.flagged}/${c.genuine} |`;
  });
  return [
    `Gate: ${r.passed ? "PASSED" : "FAILED"}`,
    "",
    "| set | scams caught (active) | scams caught (candidate) | genuine flagged (active) | genuine flagged (candidate) |",
    "|---|---|---|---|---|",
    ...rows,
    `| UCI genuine SMS FPR | | | ${(r.active.uciHamFpr * 100).toFixed(2)}% | ${(r.candidate.uciHamFpr * 100).toFixed(2)}% |`,
    "",
    ...(r.reasons.length ? ["Reasons:", ...r.reasons.map((x) => `- ${x}`)] : []),
  ].join("\n");
}
