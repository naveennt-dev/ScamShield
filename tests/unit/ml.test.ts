import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedClassifier } from "@/lib/detection/ml/classifier";
import { createMlEngine, resetMlServiceCooldown } from "@/lib/detection/ml";
import { MlServiceClient } from "@/lib/detection/ml/service-client";
import { charFeatures, tokenize, wordFeatures } from "@/lib/detection/ml/tokenizer";

const model = JSON.parse(readFileSync("ml/models/scam_classifier.json", "utf8"));
const fixture = JSON.parse(readFileSync("src/lib/detection/ml/__fixtures__/parity.json", "utf8")) as {
  modelBuildId: string;
  cases: Array<{ text: string; tokens: string[]; labelProba: Record<string, number> }>;
};

describe("tokenizer v2 (signal-preserving, Unicode-aware)", () => {
  it("keeps scam signals as typed tokens", () => {
    const t = tokenize("Your account will be blocked! Pay ₹499 now: https://fake-example.com");
    expect(t).toEqual(expect.arrayContaining(["blocked", "pay", "moneytoken", "urltoken", "fake", "example", "tld_com"]));
  });
  it("keeps Devanagari words whole and Hinglish intact", () => {
    expect(tokenize("आपका KYC expire हो गया है")).toEqual(["आपका", "kyc", "expire", "हो", "गया", "है"]);
    expect(tokenize("Apka KYC expire ho gya hai, abhi verify kro")).toContain("kro");
  });
  it("normalises Unicode tricks and whitespace", () => {
    expect(tokenize("ＯＴＰ sha​re   now")).toEqual(["otp", "share", "now"]);
  });
  it("produces word bigrams and in-word char n-grams (code points)", () => {
    expect(wordFeatures("share otp now")).toContain("share otp");
    expect(charFeatures("खाता")).toContain(" खा");
  });
});

describe("embedded model — TypeScript/Python parity", () => {
  const clf = EmbeddedClassifier.fromJson(model);

  it("fixture matches the committed model", () => {
    expect(fixture.modelBuildId).toBe(clf.info.buildId);
  });

  it.each(fixture.cases.map((c, i) => [i, c] as const))("case %i: identical tokens and calibrated probabilities", (_i, c) => {
    expect(tokenize(c.text)).toEqual(c.tokens);
    const r = clf.rawPredict(c.text);
    for (const [k, v] of Object.entries(c.labelProba)) expect(r.label[k]).toBeCloseTo(v, 9);
  });

  it("returns bounded scores with model identity", async () => {
    const p = await clf.predict("Your KYC has expired, update now or account will be blocked");
    expect(p.riskScore).toBeGreaterThanOrEqual(0);
    expect(p.riskScore).toBeLessThanOrEqual(100);
    expect(p.confidence).toBeGreaterThanOrEqual(0);
    expect(p.confidence).toBeLessThanOrEqual(1);
    expect(p.model).toMatchObject({ name: "scam-tfidf-logreg" });
    expect(p.backend).toBe("embedded");
    expect(p.seedModel).toBe(false); // trained on synthetic + public real data ("mixed")
  });

  it("rejects malformed or mismatched model files", () => {
    expect(() => EmbeddedClassifier.fromJson({ ...model, format: "other" })).toThrow();
    expect(() => EmbeddedClassifier.fromJson({ ...model, tokenizerVersion: "v1" })).toThrow(/tokenizer mismatch/);
    expect(() => EmbeddedClassifier.fromJson({ ...model, label: { ...model.label, coef: [[1, 2, 3]] } })).toThrow(/shape/);
  });
});

describe("ML service client", () => {
  const ok = {
    classification: "scam",
    probability: 0.9,
    probabilities: { safe: 0.05, suspicious: 0.05, scam: 0.9 },
    category: "kyc",
    categoryProbability: 0.7,
    knownFeatures: 9,
    model: { name: "scam-tfidf-logreg", version: "1.1.0", buildId: "b", trainingKind: "mixed" },
    processingTimeMs: 2,
  };
  const fetchReturning = (status: number, body: unknown) =>
    vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("maps a valid response", async () => {
    const p = await new MlServiceClient("http://127.0.0.1:8765", 500, fetchReturning(200, ok)).predict("x");
    expect(p).toMatchObject({ label: "scam", backend: "service", category: "kyc", riskScore: 93 });
  });

  it.each([
    ["non-JSON", fetchReturning(200, "<html>"), "BAD_RESPONSE"],
    ["schema violation", fetchReturning(200, { ...ok, probability: 7 }), "BAD_RESPONSE"],
    ["inconsistent probabilities", fetchReturning(200, { ...ok, probabilities: { safe: 0.9, suspicious: 0.9, scam: 0.9 } }), "BAD_RESPONSE"],
    ["unknown label", fetchReturning(200, { ...ok, classification: "maybe" }), "BAD_RESPONSE"],
    ["503", fetchReturning(503, { error: {} }), "UNAVAILABLE"],
    ["422", fetchReturning(422, { error: {} }), "REJECTED"],
    ["connection refused", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, "UNAVAILABLE"],
  ])("rejects %s", async (_n, f, code) => {
    await expect(new MlServiceClient("http://127.0.0.1:8765", 500, f).predict("x")).rejects.toMatchObject({ code });
  });

  it("times out", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("abort"))))) as unknown as typeof fetch;
    await expect(new MlServiceClient("http://127.0.0.1:8765", 50, hang).predict("x")).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("ML engine backend selection", () => {
  afterEach(() => {
    resetMlServiceCooldown();
    delete process.env.ML_BACKEND;
  });
  const clf = EmbeddedClassifier.fromJson(model);

  it("falls back to the embedded model when the service is down, then skips the service while cooling down", async () => {
    process.env.ML_BACKEND = "auto";
    const { resetEnvCache } = await import("@/lib/config/env");
    resetEnvCache();
    const down = new MlServiceClient("http://127.0.0.1:1", 100, (async () => { throw new TypeError("refused"); }) as unknown as typeof fetch);
    const spy = vi.spyOn(down, "predict");
    const engine = createMlEngine({ service: down, embedded: async () => clf });
    const first = await engine.predict("Share your OTP now");
    expect(first.prediction?.backend).toBe("embedded");
    expect(first.note).toMatch(/unavailable; used embedded/);
    await engine.predict("again");
    expect(spy).toHaveBeenCalledTimes(1); // cooldown
    resetEnvCache();
  });

  it("service-only mode reports unavailability instead of silently switching", async () => {
    process.env.ML_BACKEND = "service";
    const { resetEnvCache } = await import("@/lib/config/env");
    resetEnvCache();
    const down = new MlServiceClient("http://127.0.0.1:1", 100, (async () => { throw new TypeError("refused"); }) as unknown as typeof fetch);
    const out = await createMlEngine({ service: down, embedded: async () => clf }).predict("x");
    expect(out.prediction).toBeNull();
    resetEnvCache();
  });

  it("embedded model missing → no prediction, explained", async () => {
    process.env.ML_BACKEND = "embedded";
    const { resetEnvCache } = await import("@/lib/config/env");
    resetEnvCache();
    const out = await createMlEngine({ service: null, embedded: async () => null }).predict("x");
    expect(out).toEqual({ prediction: null, note: "embedded model missing" });
    resetEnvCache();
  });
});
