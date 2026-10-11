import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { AIError } from "@/lib/ai/errors";
import type { AIProvider } from "@/lib/ai/provider";
import { createMlEngine, type MlEngine } from "@/lib/detection/ml";
import { runPipeline } from "@/lib/detection/pipeline";
import { failingAI, fakeAI } from "../helpers/fake-ai";

/**
 * Required behaviour: every scan runs the local pipeline (rules, ML, URL checks, risk engine); with
 * remote AI enabled the same scan also gets a remote second opinion; the remote opinion can raise
 * but never lower the local risk; any remote failure yields the local result promptly; and a failed
 * local detector never silently produces a green result.
 */

const SCAM = "Dear SBI customer, your account will be blocked today. Share the OTP sent to your phone at http://sbi-kyc-verify.top/login";
const MILD = "Hi, can you confirm the delivery address for the books you ordered? We will ship tomorrow.";
const localMl = (): MlEngine => createMlEngine({ service: null }); // the installed on-device model, in-process
const run = (text: string, ai: AIProvider | null, allowLlm = true, ml: MlEngine | null = localMl()) =>
  runPipeline({ inputType: "message", text, requestId: "lr", allowLlm, remoteRequested: allowLlm }, { ai, intel: null, ml });

beforeEach(() => {
  process.env.LLM_ENABLED = "true";
  process.env.OPENROUTER_TOTAL_BUDGET_MS = "1000";
  resetEnvCache();
});
afterAll(() => {
  delete process.env.LLM_ENABLED;
  delete process.env.OPENROUTER_TOTAL_BUDGET_MS;
  resetEnvCache();
});

describe("both analyses run when remote AI is enabled", () => {
  it("local rules, local ML, URL checks AND the remote AI all contribute to one result", async () => {
    const ai = fakeAI({ classification: "scam", category: "kyc", riskScore: 90, confidence: 0.9 });
    const { result } = await run(SCAM, ai);
    const src = (s: string) => result.signals.find((x) => x.source === s);
    expect(src("rules")?.available).toBe(true);
    expect(src("ml")?.available).toBe(true);
    expect(src("url")?.available).toBe(true);
    expect(src("llm")?.available).toBe(true);
    expect(ai.calls).toHaveLength(1);
    expect(result.remoteAnalysis).toMatchObject({ requested: true, used: true, status: "ok" });
    expect(result.assessment.status).toBe("complete");
  });

  it("the remote AI receives the local findings as hints (it is a second opinion on the same scan)", async () => {
    const ai = fakeAI({ classification: "scam", riskScore: 90 });
    await run(SCAM, ai);
    expect(ai.calls[0].hints.length).toBeGreaterThan(0);
    expect(ai.calls[0].text).not.toContain("/login"); // minimised before sending
  });

  it("local-only mode never calls the remote AI", async () => {
    const ai = fakeAI({ classification: "scam", riskScore: 90 });
    const { result } = await run(SCAM, ai, false);
    expect(ai.calls).toHaveLength(0);
    expect(result.remoteAnalysis.used).toBe(false);
  });
});

describe("remote AI can raise but never lower the local risk", () => {
  it("a 'safe' remote verdict on a strong local scam leaves the local score in place", async () => {
    const local = (await run(SCAM, null, false)).result;
    const withSafeAi = (await run(SCAM, fakeAI({ classification: "safe", riskScore: 0, confidence: 1 }))).result;
    expect(local.riskLevel).toMatch(/high|critical/);
    expect(withSafeAi.riskScore).toBeGreaterThanOrEqual(local.riskScore);
    expect(withSafeAi.riskLevel).toBe(local.riskLevel);
  });

  it("a remote 'scam' verdict can raise a mild local result", async () => {
    const local = (await run(MILD, null, false)).result;
    const raised = (await run(MILD, fakeAI({ classification: "scam", category: "delivery", riskScore: 95, confidence: 1 }))).result;
    expect(raised.riskScore).toBeGreaterThan(local.riskScore);
  });
});

describe("remote failure → the local result, promptly", () => {
  it.each([
    "TIMEOUT", "RATE_LIMITED", "NETWORK", "AUTH", "NOT_CONFIGURED", "PROVIDER_5XX", "MODEL_UNAVAILABLE",
    "MALFORMED_RESPONSE", "SCHEMA_INVALID", "CIRCUIT_OPEN", "BUDGET_EXHAUSTED", "INSUFFICIENT_CREDITS",
  ] as const)("%s", async (code) => {
    const local = (await run(SCAM, null, false)).result;
    const { result } = await run(SCAM, failingAI(code));
    expect(result.riskScore).toBe(local.riskScore);
    expect(result.riskLevel).toBe(local.riskLevel);
    expect(result.remoteAnalysis).toMatchObject({ requested: true, used: false, status: "unavailable" });
    expect(result.warnings.join(" ")).toMatch(/local result is shown/);
    expect(result.assessment.status).toBe("complete");
  });

  it("a remote call that never answers is abandoned at the deadline", async () => {
    const hanging: AIProvider = { name: "hang", available: true, analyzeScam: () => new Promise(() => {}) };
    const t0 = Date.now();
    const { result } = await run(SCAM, hanging);
    expect(Date.now() - t0).toBeLessThan(5_000); // budget 1 s + 2 s grace
    expect(result.remoteAnalysis).toMatchObject({ used: false, status: "unavailable", reason: "TIMEOUT" });
    expect(result.riskLevel).toMatch(/high|critical/);
  }, 10_000);

  it("remote turned off on the server → local result with a notice", async () => {
    process.env.LLM_ENABLED = "false";
    resetEnvCache();
    const { result } = await run(SCAM, fakeAI({ riskScore: 99 }));
    expect(result.remoteAnalysis.status).toBe("disabled_on_server");
    expect(result.riskLevel).toMatch(/high|critical/);
  });

  it("an invalid remote answer is rejected by the provider and treated as a failure", async () => {
    const invalid: AIProvider = { name: "bad", available: true, analyzeScam: async () => { throw new AIError("SCHEMA_INVALID", "schema"); } };
    const { result } = await run(MILD, invalid);
    expect(result.remoteAnalysis.status).toBe("unavailable");
  });
});

describe("a failed local detector never silently produces a safe result", () => {
  const brokenMl: MlEngine = { predict: async () => ({ prediction: null, note: "ML service down; embedded model missing" }) };

  it("no rule hit + ML failed + no remote opinion → Unable to assess (grey), not green", async () => {
    const { result } = await run(MILD, null, false, brokenMl);
    expect(result.assessment.status).toBe("insufficient");
    expect(result.decision?.colour).toBe("grey");
    expect(result.decision?.why).toMatch(/^Unable to assess/);
    expect(result.warnings.join(" ")).toMatch(/not a safe verdict/);
  });

  it("ML failed but the remote AI answered → assessed", async () => {
    const { result } = await run(MILD, fakeAI({ classification: "safe", riskScore: 3 }), true, brokenMl);
    expect(result.assessment.status).toBe("complete");
  });

  it("ML failed and remote failed → Unable to assess", async () => {
    const { result } = await run(MILD, failingAI("NETWORK"), true, brokenMl);
    expect(result.assessment.status).toBe("insufficient");
  });

  it("ML failed but the rules found a scam → the warning is still shown", async () => {
    const { result } = await run(SCAM, null, false, brokenMl);
    expect(result.riskLevel).toMatch(/high|critical/);
    expect(result.assessment.status).toBe("complete");
  });

  it("everything healthy and genuine → green, assessed", async () => {
    const { result } = await run("Are we still meeting for lunch tomorrow at 1?", null, false);
    expect(result.riskLevel).toBe("safe");
    expect(result.assessment.status).toBe("complete");
    expect(result.decision?.colour).toBe("green");
  });
});

describe("inference never trains", () => {
  it("scanning does not modify the installed model files", async () => {
    const { statSync } = await import("node:fs");
    const before = ["ml/models/scam_classifier.json", "ml/models/model_manifest.json"].map((f) => statSync(f).mtimeMs);
    for (let i = 0; i < 5; i++) await run(SCAM, fakeAI({ classification: "scam", riskScore: 95 }));
    const after = ["ml/models/scam_classifier.json", "ml/models/model_manifest.json"].map((f) => statSync(f).mtimeMs);
    expect(after).toEqual(before);
  });
});
