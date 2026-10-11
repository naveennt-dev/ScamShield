/**
 * OPTIONAL live check of the Phase 4 OpenRouter integration — real network, real free model.
 * Not part of `npm test`. It refuses to run unless explicitly asked:
 *
 *   OPENROUTER_LIVE_CHECK=1 OPENROUTER_API_KEY=… SCAM_PRIMARY_MODEL=google/gemma-4-31b-it:free \
 *     npx tsx scripts/openrouter-live-check.ts
 *
 * Sends ONE synthetic scam message (no personal data) through the production pipeline with
 * remote analysis requested, and prints the diagnostics. Never prints the key.
 */
import { resetEnvCache } from "../src/lib/config/env";
import { runPipeline } from "../src/lib/detection/pipeline";

async function main() {
  if (process.env.OPENROUTER_LIVE_CHECK !== "1") {
    console.log("Refusing: set OPENROUTER_LIVE_CHECK=1 to make a real OpenRouter call.");
    process.exit(2);
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("OPENROUTER_API_KEY is not set (expected for local-only use). Nothing sent.");
    process.exit(2);
  }
  process.env.LLM_ENABLED = "true";
  resetEnvCache();
  const synthetic =
    "Dear customer, your KYC has expired. Your account will be blocked in 2 hours. Share the OTP sent to your phone and update at http://kyc-verify-update.example/login";
  const started = Date.now();
  const { result } = await runPipeline(
    { inputType: "message", text: synthetic, requestId: "live-check", allowLlm: true, remoteRequested: true },
    { intel: null },
  );
  console.log(
    JSON.stringify(
      {
        elapsedMs: Date.now() - started,
        remoteAnalysis: result.remoteAnalysis,
        llmMetadata: result.modelMetadata.llm,
        riskLevel: result.riskLevel,
        riskScore: result.riskScore,
        warnings: result.warnings,
      },
      null,
      2,
    ),
  );
  process.exit(result.remoteAnalysis.used ? 0 : 1);
}

void main();
