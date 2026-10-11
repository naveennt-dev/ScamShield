/**
 * System-level evaluation of the LOCAL detection engine (rules + ML + static URL checks; no LLM,
 * no network). Complements ml/training/evaluate.py, which measures the ML model alone.
 *
 *   npx tsx scripts/evaluate-system.ts
 *
 * Inputs:
 *   ml/datasets/processed/test.jsonl     held-out test split (never trained on)
 *   ml/datasets/eval/scenario_suite.jsonl controlled safe / scam / adversarial scenarios (never trained on)
 * Output: ml/evaluation/reports/system-<buildId>.{json,md}
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

process.env.LLM_ENABLED = "false";
process.env.ML_BACKEND = "embedded"; // deterministic; identical maths to the Python service
process.env.LOG_LEVEL = "error";
delete process.env.DATABASE_URL; // no intel lookups: measure the engine itself

async function main() {
  const { runPipeline } = await import("@/lib/detection/pipeline");
  const manifest = JSON.parse(readFileSync("ml/models/model_manifest.json", "utf8"));

  type Row = { text: string; label: string; source: string; language?: string };
  const test: Row[] = readFileSync("ml/datasets/processed/test.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const scenarios: Array<{ group: string; name: string; text: string; expect: string }> = readFileSync("ml/datasets/eval/scenario_suite.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  async function classify(text: string) {
    const { result, internals } = await runPipeline({ inputType: "message", text, requestId: "eval", allowLlm: false }, { ai: null, intel: null });
    return { system: result.classification, level: result.riskLevel, score: result.riskScore, ml: internals.ml?.label ?? "none", rules: internals.ruleSignals.length };
  }

  const sourceOf = (r: Row) => (r.source.startsWith("synthetic") ? "synthetic" : r.source);
  const labels = ["safe", "suspicious", "scam"];
  const perSource: Record<string, { rows: number; system: Record<string, Record<string, number>>; ml: Record<string, Record<string, number>> }> = {};
  const t0 = Date.now();
  for (const r of test) {
    const out = await classify(r.text);
    const s = (perSource[sourceOf(r)] ??= { rows: 0, system: {}, ml: {} });
    s.rows++;
    for (const [k, pred] of [["system", out.system], ["ml", out.ml]] as const) {
      s[k][r.label] ??= Object.fromEntries(labels.map((l) => [l, 0]));
      s[k][r.label][pred] = (s[k][r.label][pred] ?? 0) + 1;
    }
  }
  const msPerMessage = (Date.now() - t0) / test.length;

  function summary(cm: Record<string, Record<string, number>>) {
    const total = Object.values(cm).reduce((a, row) => a + Object.values(row).reduce((x, y) => x + y, 0), 0);
    const correct = labels.reduce((a, l) => a + (cm[l]?.[l] ?? 0), 0);
    const scam = cm.scam ?? {};
    const safe = cm.safe ?? {};
    const nScam = Object.values(scam).reduce((a, b) => a + b, 0);
    const nSafe = Object.values(safe).reduce((a, b) => a + b, 0);
    return {
      accuracy: total ? +(correct / total).toFixed(4) : null,
      scamRecall: nScam ? +((scam.scam ?? 0) / nScam).toFixed(4) : null,
      scamMissedAsSafe: scam.safe ?? 0,
      safeFalsePositiveRate: nSafe ? +((nSafe - (safe.safe ?? 0)) / nSafe).toFixed(4) : null,
      confusion: cm,
    };
  }

  const scenarioResults = [];
  for (const s of scenarios) {
    const out = await classify(s.text);
    const pass = s.expect === "not-safe" ? out.system !== "safe" : out.system === s.expect;
    scenarioResults.push({ ...s, ...out, pass });
  }

  const report = {
    model: { name: manifest.name, version: manifest.version, buildId: manifest.buildId, probabilityType: manifest.probabilityType },
    engine: "rules + ML (embedded) + static URL analysis; LLM disabled; no network",
    msPerMessage: +msPerMessage.toFixed(2),
    testSplit: Object.fromEntries(Object.entries(perSource).map(([k, v]) => [k, { rows: v.rows, system: summary(v.system), mlOnly: summary(v.ml) }])),
    scenarios: {
      passed: scenarioResults.filter((r) => r.pass).length,
      total: scenarioResults.length,
      results: scenarioResults.map(({ group, name, expect, system, level, score, ml, pass }) => ({ group, name, expect, system, level, score, ml, pass })),
    },
  };
  mkdirSync("ml/evaluation/reports", { recursive: true });
  const stem = `ml/evaluation/reports/system-${manifest.buildId}`;
  writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2));
  let md = `# System evaluation — ${manifest.buildId}\n\n> Synthetic scam data + public UCI SMS. Not a measure of real-world scam detection accuracy.\n\nEngine: ${report.engine}. ${report.msPerMessage} ms/message.\n\n## Held-out test split\n\n| source | rows | system acc | system scam recall | scam→safe | safe FPR | ML-only acc | ML-only scam recall | ML-only safe FPR |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const [k, v] of Object.entries(report.testSplit)) {
    md += `| ${k} | ${v.rows} | ${v.system.accuracy} | ${v.system.scamRecall ?? "–"} | ${v.system.scamMissedAsSafe} | ${v.system.safeFalsePositiveRate ?? "–"} | ${v.mlOnly.accuracy} | ${v.mlOnly.scamRecall ?? "–"} | ${v.mlOnly.safeFalsePositiveRate ?? "–"} |\n`;
  }
  md += `\n## Scenario suite (${report.scenarios.passed}/${report.scenarios.total})\n\n| group | scenario | expected | system | score | ML alone | ✓ |\n|---|---|---|---|---|---|---|\n`;
  for (const r of report.scenarios.results) md += `| ${r.group} | ${r.name} | ${r.expect} | ${r.system} (${r.level}) | ${r.score} | ${r.ml} | ${r.pass ? "✓" : "✗"} |\n`;
  writeFileSync(`${stem}.md`, md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
