/**
 * Local-scan latency benchmark (Phase 6): runs the production pipeline in-process — rules, URL
 * analysis, ML via the local service (embedded fallback), risk engine — remote AI off, no network.
 *   npx tsx --env-file=.env scripts/bench-local.ts [iterations]
 */
import { runPipeline } from "../src/lib/detection/pipeline";

const MESSAGES = [
  "Dear customer aapka account block ho jayega. OTP batao abhi, verify at sbi-kyc-verify.xyz",
  "Your Amazon order has shipped. Track it at https://www.amazon.in/gp/your-account/order-history",
  "Congratulations! You won Rs 25,00,000 in KBC lucky draw. Pay processing fee of Rs 4,999 to claim.",
  "Hi Ravi, are we still on for lunch tomorrow at 1? Let me know if you want to move it.",
  "Your parcel is on hold. Pay the redelivery fee at indiapost-redelivery[.]top/pay today.",
];

async function main() {
  const n = Number(process.argv[2] ?? 100);
  for (const m of MESSAGES) await runPipeline({ inputType: "message", text: m, requestId: "warm", allowLlm: false }, { ai: null, intel: null });
  const times: number[] = [];
  const backends = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const { result } = await runPipeline({ inputType: "message", text: MESSAGES[i % MESSAGES.length], requestId: `b${i}`, allowLlm: false }, { ai: null, intel: null });
    times.push(performance.now() - t);
    const b = result.model?.backend ?? "none";
    backends.set(b, (backends.get(b) ?? 0) + 1);
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(1);
  console.log(`local pipeline, ${n} scans: p50 ${q(0.5)} ms · p95 ${q(0.95)} ms · max ${times[times.length - 1].toFixed(1)} ms · ML backend ${JSON.stringify(Object.fromEntries(backends))}`);
}
void main();
