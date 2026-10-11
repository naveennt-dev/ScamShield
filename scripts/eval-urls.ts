/**
 * Look-alike URL evaluation on tests/fixtures/eval/urls-v1.jsonl (labelled by hand, written before
 * the look-alike changes; SHA-256 9b540a3c…). Device-only link scans (no network).
 *   npx tsx --env-file=.env scripts/eval-urls.ts [--verbose]
 * Positive = malicious. Two thresholds: "high" (High risk / Malicious) and "warn" (any warning).
 */
import { readFileSync } from "node:fs";
import { createMlEngine } from "../src/lib/detection/ml";
import { scanLink } from "../src/lib/linkscan/scan";

async function main() {
  const verbose = process.argv.includes("--verbose");
  const rows = readFileSync(process.argv.find((a) => a.endsWith(".jsonl")) ?? "tests/fixtures/eval/urls-v1.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { url: string; label: string });
  const ml = createMlEngine({ service: null });
  const res: Array<{ url: string; label: string; verdict: string; score: number }> = [];
  for (const r of rows) {
    const rep = await scanLink({ url: r.url, requestId: "e", networkAllowed: false, allowAi: false, inspectBehaviour: false }, { pipeline: { ai: null, intel: null, ml } });
    res.push({ url: r.url, label: r.label, verdict: rep.verdict, score: rep.analysis?.riskScore ?? -1 });
  }
  const pos = (v: string, t: "high" | "warn") => (t === "high" ? ["high_risk", "malicious"].includes(v) : ["high_risk", "malicious", "suspicious"].includes(v));
  for (const t of ["high", "warn"] as const) {
    const tp = res.filter((r) => r.label === "malicious" && pos(r.verdict, t)).length;
    const fp = res.filter((r) => r.label === "benign" && pos(r.verdict, t)).length;
    const fn = res.filter((r) => r.label === "malicious" && !pos(r.verdict, t)).length;
    const p = tp / Math.max(1, tp + fp), rc = tp / Math.max(1, tp + fn);
    console.log(`${t.padEnd(5)} precision ${(p * 100).toFixed(1)}%  recall ${(rc * 100).toFixed(1)}%  (TP ${tp}, FP ${fp}, FN ${fn})`);
  }
  if (verbose) {
    for (const r of res) {
      const wrong = (r.label === "malicious") !== pos(r.verdict, "warn") || (r.label === "malicious" && !pos(r.verdict, "high")) || (r.label === "benign" && pos(r.verdict, "warn"));
      if (wrong) console.log(`  ${r.label.padEnd(9)} ${r.verdict.padEnd(16)} ${String(r.score).padStart(3)}  ${r.url}`);
    }
  }
}
void main();
