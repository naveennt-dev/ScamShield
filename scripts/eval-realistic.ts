/**
 * Detection check on a JSONL set (default tests/fixtures/eval/realistic-v1.jsonl). These are
 * synthetic messages written for this project — a coverage check, not an accuracy claim.
 * heldout-v2.jsonl was written and frozen before the rules it measures (see its SHA-256 in
 * docs/ml/evaluation.md). Runs the production screen path (as a Mac region scan sends it), local only.
 *   npx tsx --env-file=.env scripts/eval-realistic.ts [file.jsonl]
 */
import { readFileSync } from "node:fs";
import { runScreenPipeline } from "../src/lib/detection/screen";

async function main() {
  const rows = readFileSync(process.argv[2] ?? "tests/fixtures/eval/realistic-v1.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; label: "scam" | "safe"; text: string });
  let missed = 0, falseAlarms = 0;
  for (const r of rows) {
    const { result } = await runScreenPipeline({ inputType: "message", text: r.text, requestId: `eval-${r.id}`, allowLlm: false }, { ai: null, intel: null });
    const warned = result.riskLevel !== "safe";
    const ok = (r.label === "scam") === warned;
    if (!ok && r.label === "scam") missed++;
    if (!ok && r.label === "safe") falseAlarms++;
    const rules = result.indicators.filter((i) => i.source === "rules").map((i) => i.type).join(",");
    console.log(`${ok ? "✓" : "✗"} ${r.label.padEnd(4)} ${r.id.padEnd(20)} ${result.riskLevel.padEnd(10)} ${String(result.riskScore).padStart(3)}  ml=${String(result.signals.find((s) => s.source === "ml")?.score ?? "-").padStart(3)}  rules=[${rules}]`);
  }
  const scams = rows.filter((r) => r.label === "scam").length, safe = rows.length - scams;
  console.log(`\nscams caught ${scams - missed}/${scams} · genuine flagged ${falseAlarms}/${safe}`);
}
void main();
