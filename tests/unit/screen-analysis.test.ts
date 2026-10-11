import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/detection/pipeline";
import { joinSoftWraps, runScreenPipeline, splitScreenBlocks } from "@/lib/detection/screen";
import { AnalyzeMessageSchema } from "@/lib/schemas/api";
import { fakeAI } from "../helpers/fake-ai";

/**
 * Corrective fix — screen-scan analysis. These are DIRECT-TEXT tests of the backend logic (the
 * text is supplied, not captured). Real-capture results are recorded separately with
 * `ScamShield --scan-eval` (docs/phases/phase-6-completion.md).
 */

const MESSAGES: { id: string; expect: "safe" | "warn"; text: string }[] = JSON.parse(readFileSync("tests/fixtures/e2e/messages.json", "utf8"));
const wrap = (t: string, w = 38) =>
  t.split(" ").reduce((lines: string[], word) => {
    const l = lines[lines.length - 1];
    if (l && `${l} ${word}`.length <= w) lines[lines.length - 1] = `${l} ${word}`;
    else lines.push(word);
    return lines;
  }, []).join("\n");

const screen = (text: string, deps = { ai: null, intel: null }) =>
  runScreenPipeline({ inputType: "message", text, requestId: "s", allowLlm: false }, deps);

// Desktop/UI fragments as they appear in a full-screen capture (synthetic, no user data).
const UI_BLOCKS = [
  "Finder File Edit View Go Window Help Sun 11 Oct 1:25 AM",
  "Documents Downloads Desktop Applications",
  "L Tip: Use /btw to ask a quick side question without interrupting the current work / Update installed • Restart to update",
  "Lab notes.pdf Project-final.zip Screenshot 2026-10-10 at 4.42 PM",
];

describe("OCR soft wraps no longer break the detector's phrases", () => {
  it("joins wrapped lines inside a block", () => {
    expect(joinSoftWraps("please share the\nOTP sent to\nyour phone")).toBe("please share the OTP sent to your phone");
  });

  it.each(MESSAGES.map((m) => [m.id, m] as const))("%s: wrapped (as OCR returns it) scores like the one-line text", async (_id, m) => {
    const oneLine = (await runPipeline({ inputType: "message", text: m.text, requestId: "o", allowLlm: false }, { ai: null, intel: null })).result;
    const wrapped = (await screen(wrap(m.text))).result;
    expect(wrapped.riskLevel).toBe(oneLine.riskLevel);
    expect(wrapped.riskScore).toBe(oneLine.riskScore);
  });
});

describe("controlled message set (direct text through the screen path)", () => {
  it.each(MESSAGES.map((m) => [m.id, m] as const))("%s", async (_id, m) => {
    const r = (await screen(wrap(m.text))).result;
    if (m.expect === "safe") expect(r.riskLevel).toBe("safe");
    else expect(["suspicious", "high", "critical"]).toContain(r.riskLevel);
    // Reasons come from the detector, never filler.
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("full-screen text: a scam among unrelated screen text", () => {
  const scam = MESSAGES.find((m) => m.id === "hinglish-scam")!.text;
  const harmless = MESSAGES.find((m) => m.id === "harmless-personal")!.text;

  it("the scam block is found and its own evidence is reported", async () => {
    const text = [UI_BLOCKS[0], UI_BLOCKS[1], wrap(scam), UI_BLOCKS[2], UI_BLOCKS[3]].join("\n\n");
    const o = await screen(text);
    expect(["suspicious", "high", "critical"]).toContain(o.result.riskLevel);
    expect(o.screen.blocks).toBe(5);
    expect(o.result.indicators.map((i) => i.type)).toContain("cred.otp_request");
    expect(o.result.warnings.join(" ")).toMatch(/5 separate text areas/);
  });

  it("before the fix — the same text analysed as one blob — scores lower (dilution is real)", async () => {
    const text = [UI_BLOCKS[0], UI_BLOCKS[1], wrap(scam), UI_BLOCKS[2], UI_BLOCKS[3]].join("\n\n");
    const blob = (await runPipeline({ inputType: "message", text, requestId: "b", allowLlm: false }, { ai: null, intel: null })).result;
    const fixed = (await screen(text)).result;
    expect(fixed.riskScore).toBeGreaterThan(blob.riskScore);
  });

  it("a harmless screen with UI fragments stays safe (an ML-only fragment can't win)", async () => {
    const o = await screen([UI_BLOCKS[0], wrap(harmless), UI_BLOCKS[2], UI_BLOCKS[3]].join("\n\n"));
    expect(o.result.riskLevel).toBe("safe");
  });

  it("splits on blank lines only and drops tiny fragments", () => {
    expect(splitScreenBlocks("a\n\nHello there, this is a real line of text\nwrapped here\n\n  \n\nok")).toEqual(["Hello there, this is a real line of text wrapped here"]);
  });
});

describe("remote AI on screen scans", () => {
  it("sees only the selected block and still can't lower the local score", async () => {
    const scam = MESSAGES.find((m) => m.id === "kyc-request")!.text;
    const text = [UI_BLOCKS[0], wrap(scam), UI_BLOCKS[3]].join("\n\n");
    const local = (await screen(text)).result;
    const ai = fakeAI({ classification: "safe", riskScore: 1, confidence: 0.99 });
    const remote = await runScreenPipeline({ inputType: "message", text, requestId: "r", allowLlm: true, remoteRequested: true }, { ai, intel: null });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].text).not.toContain("Finder File Edit");
    expect(remote.result.riskScore).toBeGreaterThanOrEqual(local.riskScore);
  });
});

describe("API contract", () => {
  it("accepts source=screen, defaults to text, rejects anything else", () => {
    expect(AnalyzeMessageSchema.parse({ message: "hi" }).source).toBe("text");
    expect(AnalyzeMessageSchema.parse({ message: "hi", source: "screen" }).source).toBe("screen");
    expect(AnalyzeMessageSchema.safeParse({ message: "hi", source: "demo" }).success).toBe(false);
  });
});
