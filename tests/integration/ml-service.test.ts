import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => null }));

import { getEnv, resetEnvCache } from "@/lib/config/env";
import { resetMlServiceCooldown } from "@/lib/detection/ml";
import { setRateLimitStore } from "@/lib/rate-limit";
import { MemoryRateLimitStore } from "@/lib/rate-limit/memory";
import * as message from "@/app/api/v1/analyze/message/route";

/**
 * The analysis API with a REAL local HTTP stand-in for the Python ML service, exercising the
 * service client, Zod validation, timeouts and fallback over an actual socket.
 */

type Mode = "ok" | "malformed" | "slow" | "error500";
let mode: Mode = "ok";
let requests = 0;
let server: http.Server;
let url = "";

const OK = {
  classification: "scam",
  probability: 0.91,
  probabilities: { safe: 0.04, suspicious: 0.05, scam: 0.91 },
  category: "kyc",
  categoryProbability: 0.8,
  knownFeatures: 12,
  model: { name: "scam-tfidf-logreg", version: "1.1.0", buildId: "test-build", trainingKind: "mixed" },
  processingTimeMs: 1.2,
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: string) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
      };
      if (mode === "slow") return void setTimeout(() => send(200, JSON.stringify(OK)), 2000);
      if (mode === "malformed") return send(200, JSON.stringify({ ...OK, probability: 4, classification: "definitely" }));
      if (mode === "error500") return send(500, JSON.stringify({ error: { code: "INTERNAL_ERROR" } }));
      expect(JSON.parse(body)).toHaveProperty("text"); // the API forwards the text only
      send(200, JSON.stringify(OK));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function configure(backend: "service" | "auto", serviceUrl = url) {
  process.env.ML_BACKEND = backend;
  process.env.ML_SERVICE_URL = serviceUrl;
  process.env.ML_SERVICE_TIMEOUT_MS = "300";
  resetEnvCache();
  resetMlServiceCooldown();
}

beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore());
  requests = 0;
  mode = "ok";
});

afterAll(() => {
  process.env.ML_BACKEND = "embedded";
  delete process.env.ML_SERVICE_URL;
  delete process.env.ML_SERVICE_TIMEOUT_MS;
  resetEnvCache();
});

let ip = 0;
async function analyze(text: string) {
  const req = new Request("http://localhost:3000/api/v1/analyze/message", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++ip}` },
    body: JSON.stringify({ message: text }),
  });
  const res = await message.POST(req);
  return { status: res.status, json: await res.json() };
}

const KYC = "Dear SBI customer, your KYC has expired. Update now at http://sbi-kyc-update.xyz or your account will be blocked.";

describe("analysis API ↔ local ML service", () => {
  it("uses the service and returns the canonical response (model + processingTimeMs)", async () => {
    configure("service");
    const r = await analyze(KYC);
    expect(r.status).toBe(200);
    expect(requests).toBe(1);
    expect(r.json.data.model).toEqual({ name: "scam-tfidf-logreg", version: "1.1.0", buildId: "test-build", backend: "service" });
    expect(r.json.data.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(r.json.data).toMatchObject({ classification: "scam", category: expect.any(String), indicators: expect.any(Array) });
    expect(r.json.data.signals.find((s: { source: string }) => s.source === "ml").available).toBe(true);
  });

  it.each([
    ["malformed response", "malformed" as Mode],
    ["timeout", "slow" as Mode],
    ["server error", "error500" as Mode],
  ])("service-only mode, %s → rules-only result with a warning (never a crash)", async (_n, m) => {
    configure("service");
    mode = m;
    const r = await analyze(KYC);
    expect(r.status).toBe(200);
    expect(r.json.data.model).toBeNull();
    expect(r.json.data.signals.find((s: { source: string }) => s.source === "ml").available).toBe(false);
    expect(r.json.data.warnings.join(" ")).toMatch(/ML classifier was unavailable/);
    expect(["high", "critical"]).toContain(r.json.data.riskLevel); // rules still catch it
  });

  it("auto mode: service down → embedded model takes over", async () => {
    configure("auto", "http://127.0.0.1:9"); // nothing listens on the discard port
    const r = await analyze(KYC);
    expect(r.status).toBe(200);
    expect(r.json.data.model.backend).toBe("embedded");
    expect(r.json.data.model.name).toBe("scam-tfidf-logreg");
  });

  it("auto mode: after a failure the service is skipped during the cool-down", async () => {
    configure("auto");
    mode = "error500";
    await analyze(KYC);
    mode = "ok";
    const second = await analyze(KYC);
    expect(requests).toBe(1);
    expect(second.json.data.model.backend).toBe("embedded");
  });

  it("rejects a non-loopback ML service URL at configuration time", () => {
    process.env.ML_SERVICE_URL = "https://ml.example.com";
    resetEnvCache();
    expect(() => getEnv()).toThrow(/loopback/);
    configure("service");
  });
});
