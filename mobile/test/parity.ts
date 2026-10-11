/**
 * Parity: the bundled device engine (mobile/www/engine.js, run in a sandbox WITHOUT Node APIs)
 * must give the same risk level and score as the shared server pipeline for every test item.
 *   ML_BACKEND=embedded npx tsx --env-file=.env mobile/test/parity.ts
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createMlEngine } from "../../src/lib/detection/ml";
import { runScreenPipeline } from "../../src/lib/detection/screen";
import { scanLink } from "../../src/lib/linkscan/scan";

type Engine = { analyzeMessage(t: string, s: "text" | "screen"): Promise<{ riskLevel: string; riskScore: number }>; analyzeLink(u: string): Promise<{ verdict: string; analysis: { riskScore: number } | null }> };

async function main() {
  // Browser-like globals only: no require, no process (the bundle defines its own), no Buffer.
  const sandbox: Record<string, unknown> = { console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, AbortController, AbortSignal, Intl, structuredClone };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync("mobile/www/engine.js", "utf8"), sandbox);
  const device = sandbox.ScamShieldEngine as Engine;
  const ml = createMlEngine({ service: null });
  let same = 0, diff = 0;
  for (const set of ["blind-v3", "heldout-v2", "realistic-v1"]) {
    const rows = readFileSync(`tests/fixtures/eval/${set}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; label: string; text: string });
    let caught = 0, flagged = 0, scams = 0;
    for (const r of rows) {
      const server = (await runScreenPipeline({ inputType: "message", text: r.text, requestId: "p", allowLlm: false }, { ai: null, intel: null, ml })).result;
      const dev = await device.analyzeMessage(r.text, "screen");
      if (server.riskLevel === dev.riskLevel && server.riskScore === dev.riskScore) same++; else { diff++; console.log(`DIFF ${set}/${r.id}: server ${server.riskLevel} ${server.riskScore} · device ${dev.riskLevel} ${dev.riskScore}`); }
      if (r.label === "scam") { scams++; if (dev.riskLevel !== "safe") caught++; } else if (dev.riskLevel !== "safe") flagged++;
    }
    console.log(`device ${set}: scams caught ${caught}/${scams} · genuine flagged ${flagged}/${rows.length - scams}`);
  }
  for (const set of ["urls-v1", "urls-blind-v2"]) {
    const rows = readFileSync(`tests/fixtures/eval/${set}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { url: string; label: string });
    let tp = 0, fp = 0, mal = 0;
    for (const r of rows) {
      const server = await scanLink({ url: r.url, requestId: "p", networkAllowed: false, allowAi: false, inspectBehaviour: false }, { pipeline: { ai: null, intel: null, ml } });
      const dev = await device.analyzeLink(r.url);
      if (server.verdict === dev.verdict && server.analysis?.riskScore === dev.analysis?.riskScore) same++; else { diff++; console.log(`DIFF ${set}: ${r.url} server ${server.verdict} ${server.analysis?.riskScore} · device ${dev.verdict} ${dev.analysis?.riskScore}`); }
      const warn = dev.verdict !== "no_known_threat";
      if (r.label === "malicious") { mal++; if (warn) tp++; } else if (warn) fp++;
    }
    console.log(`device ${set}: malicious warned ${tp}/${mal} · benign warned ${fp}/${rows.length - mal}`);
  }
  console.log(`PARITY: ${same} identical, ${diff} different`);
  process.exit(diff === 0 ? 0 : 1);
}
void main();
