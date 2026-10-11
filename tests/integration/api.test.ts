import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

// Identity comes only from the (mocked) session — never from the request.
const session = vi.hoisted(() => ({ current: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => session.current }));

import { prisma } from "@/lib/db/prisma";
import { resetEnvCache } from "@/lib/config/env";
import { setAIProvider } from "@/lib/ai/provider";
import { fakeAI } from "../helpers/fake-ai";
import { setRateLimitStore } from "@/lib/rate-limit";
import { MemoryRateLimitStore } from "@/lib/rate-limit/memory";
import { setOcrProvider, type OcrProvider } from "@/lib/ocr/provider";
import * as message from "@/app/api/v1/analyze/message/route";
import * as urlRoute from "@/app/api/v1/analyze/url/route";
import * as email from "@/app/api/v1/analyze/email/route";
import * as image from "@/app/api/v1/analyze/image/route";
import * as history from "@/app/api/v1/history/route";
import * as historyItem from "@/app/api/v1/history/[id]/route";
import * as reports from "@/app/api/v1/reports/route";
import * as settings from "@/app/api/v1/settings/route";
import * as stats from "@/app/api/v1/stats/route";
import * as health from "@/app/api/v1/health/route";
import * as metricsRoute from "@/app/api/v1/metrics/route";
import * as cron from "@/app/api/v1/cron/retention/route";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const BASE = "http://localhost:3000";
let ipCounter = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx?: { params?: Promise<any> }) => Promise<Response>;

async function call(
  handler: Handler,
  opts: { method?: string; path?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; user?: SessionUser | null; params?: Record<string, string> } = {},
) {
  session.current = opts.user ?? null;
  const headers: Record<string, string> = { "x-forwarded-for": `198.51.100.${++ipCounter % 250}`, ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] ??= "application/json";
  const req = new Request(`${BASE}${opts.path ?? "/api/test"}`, {
    method: opts.method ?? (opts.body !== undefined || opts.raw ? "POST" : "GET"),
    headers,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

const userA: SessionUser = { id: "itest-user-a", email: "a@test.local", name: "A", tier: "authenticated" };
const userB: SessionUser = { id: "itest-user-b", email: "b@test.local", name: "B", tier: "authenticated" };
const SCAM = "Dear SBI customer, your KYC has expired and your account will be blocked today. Share OTP 482913 at http://sbi-kyc-update.xyz/login";

describe.skipIf(!HAS_DB)("API integration (database)", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "analysis_event", "scam_indicator", "url_analysis", "scam_report", "scam_pattern", "scam_analysis", "user_settings" CASCADE',
    );
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    const now = new Date();
    for (const u of [userA, userB]) {
      await prisma.user.create({ data: { id: u.id, email: u.email, name: u.name, emailVerified: true, createdAt: now, updatedAt: now } });
    }
    setAIProvider(null);
  });

  beforeEach(() => {
    setRateLimitStore(new MemoryRateLimitStore());
    setOcrProvider(null);
    resetEnvCache();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await prisma.$disconnect();
  });

  describe("message analysis", () => {
    it("analyses anonymously without persisting", async () => {
      const r = await call(message.POST, { body: { message: SCAM } });
      expect(r.status).toBe(200);
      expect(r.json.success).toBe(true);
      expect(r.json.data.id).toBeNull();
      expect(["high", "critical"]).toContain(r.json.data.riskLevel);
      expect(r.json.meta).toMatchObject({ version: "v1" });
      expect(r.json.meta.requestId).toBe(r.headers.get("x-request-id"));
    });

    it("persists for signed-in users with a masked preview", async () => {
      const r = await call(message.POST, { body: { message: SCAM }, user: userA });
      expect(r.status).toBe(200);
      const row = await prisma.scamAnalysis.findUniqueOrThrow({ where: { id: r.json.data.id }, include: { indicators: true } });
      expect(row.userId).toBe(userA.id);
      expect(row.contentPreview).not.toContain("482913");
      expect(row.indicators.length).toBeGreaterThan(0);
      expect(JSON.stringify(row)).not.toContain("482913");
    });

    it.each([
      ["malformed JSON", { raw: "{\"message\":", headers: { "content-type": "application/json" } }, 400, "MALFORMED_JSON"],
      ["wrong content type", { raw: "message=hi", headers: { "content-type": "application/x-www-form-urlencoded" } }, 415, "UNSUPPORTED_MEDIA_TYPE"],
      ["empty message", { body: { message: "   " } }, 400, "VALIDATION_ERROR"],
      ["missing message", { body: {} }, 400, "VALIDATION_ERROR"],
      ["non-string message", { body: { message: 42 } }, 400, "VALIDATION_ERROR"],
      ["client-supplied userId", { body: { message: "hi", userId: userB.id } }, 400, "VALIDATION_ERROR"],
      ["over max length", { body: { message: "a ".repeat(6000) } }, 413, "PAYLOAD_TOO_LARGE"],
      ["over max body size", { raw: JSON.stringify({ message: "a".repeat(200_000) }), headers: { "content-type": "application/json" } }, 413, "PAYLOAD_TOO_LARGE"],
    ])("rejects %s", async (_n, opts, status, code) => {
      const r = await call(message.POST, opts as Parameters<typeof call>[1]);
      expect(r.status).toBe(status);
      expect(r.json).toMatchObject({ success: false, error: { code } });
      expect(JSON.stringify(r.json)).not.toMatch(/at \w+ \(|stack/i); // no stack traces
    });

    it("rejects cross-site POSTs and accepts same-origin ones", async () => {
      expect((await call(message.POST, { body: { message: "hi" }, headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await call(message.POST, { body: { message: "hi" }, headers: { origin: BASE, host: "localhost:3000" } })).status).toBe(200);
    });

    it("rate-limits anonymous callers with Retry-After", async () => {
      const ip = "203.0.113.77";
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await call(message.POST, { body: { message: "hello" }, headers: { "x-forwarded-for": ip } })).status);
      expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
      const last = await call(message.POST, { body: { message: "hello" }, headers: { "x-forwarded-for": ip } });
      expect(last.status).toBe(429);
      expect(last.headers.get("retry-after")).toBeTruthy();
      expect(last.json.error.code).toBe("RATE_LIMITED");
    });

    it("can require sign-in for analysis via ALLOW_ANONYMOUS_ANALYSIS=false", async () => {
      process.env.ALLOW_ANONYMOUS_ANALYSIS = "false";
      resetEnvCache();
      try {
        expect((await call(message.POST, { body: { message: "hi" } })).status).toBe(401);
      } finally {
        delete process.env.ALLOW_ANONYMOUS_ANALYSIS;
        resetEnvCache();
      }
    });
  });

  describe("history authorization", () => {
    it("requires authentication", async () => {
      expect((await call(history.GET)).status).toBe(401);
      expect((await call(historyItem.GET, { params: { id: "abcdefghijk" } })).status).toBe(401);
    });

    it("never exposes another user's analysis", async () => {
      const mine = await call(message.POST, { body: { message: SCAM }, user: userA });
      const id = mine.json.data.id as string;
      expect((await call(historyItem.GET, { params: { id }, user: userA })).status).toBe(200);
      expect((await call(historyItem.GET, { params: { id }, user: userB })).status).toBe(404);
      expect((await call(historyItem.DELETE, { method: "DELETE", params: { id }, user: userB })).status).toBe(404);
      const listB = await call(history.GET, { path: "/api/v1/history", user: userB });
      expect(listB.json.data.items.map((i: { id: string }) => i.id)).not.toContain(id);
      expect(await prisma.scamAnalysis.count({ where: { id } })).toBe(1);
    });

    it("paginates and filters the caller's history", async () => {
      const r = await call(history.GET, { path: "/api/v1/history?limit=1&classification=scam", user: userA });
      expect(r.status).toBe(200);
      expect(r.json.data.items).toHaveLength(1);
      expect(r.json.data.nextCursor).toBeTruthy();
      expect((await call(history.GET, { path: "/api/v1/history?limit=500", user: userA })).status).toBe(400);
    });

    it("returns a full stored analysis", async () => {
      const list = await call(history.GET, { path: "/api/v1/history", user: userA });
      const r = await call(historyItem.GET, { params: { id: list.json.data.items[0].id }, user: userA });
      expect(r.json.data).toMatchObject({ riskLevel: expect.any(String), reasons: expect.any(Array), urls: expect.any(Array) });
    });
  });

  describe("URL, email and image analysis", () => {
    it("flags internal URLs without fetching them and validates input", async () => {
      const r = await call(urlRoute.POST, { body: { url: "http://127.0.0.1:8080/admin", followRedirects: true } });
      expect(r.status).toBe(200);
      expect(r.json.data.urls[0].flags.map((f: { id: string }) => f.id)).toContain("host.internal_target");
      expect(r.json.data.warnings.join(" ")).toMatch(/Redirect checking is disabled/);
      expect((await call(urlRoute.POST, { body: { url: "not a url at all" } })).status).toBe(400);
      const js = await call(urlRoute.POST, { body: { url: "javascript:alert(1)" } });
      expect(js.json.data.urls[0].flags.map((f: { id: string }) => f.id)).toContain("scheme.dangerous");
    });

    it("analyses email metadata safely", async () => {
      const r = await call(email.POST, {
        body: {
          from: '"SBI Bank" <sbi.alerts@gmail.com>',
          subject: "Account blocked — verify KYC",
          body: "Your KYC is pending and your account will be blocked today. Open the attachment.",
          attachments: [{ filename: "KYC_form.pdf.exe", sizeBytes: 12345 }],
        },
        user: userA,
      });
      expect(r.status).toBe(200);
      expect(r.json.data.email.attachments[0].risk).toBe("high");
      expect(r.json.data.indicators.map((i: { type: string }) => i.type)).toEqual(expect.arrayContaining(["email.freemail_brand", "email.dangerous_attachment"]));
      expect((await call(email.POST, { body: { from: "a@b.com", subject: "", body: "" } })).status).toBe(400);
      expect((await call(email.POST, { body: { from: "a@b.com", body: "x", attachments: [{ filename: "a.exe", content: "TVqQ" }] } })).status).toBe(400);
    });

    const form = (bytes: Uint8Array, name: string, type = "image/png") => {
      const fd = new FormData();
      fd.append("image", new File([bytes], name, { type }));
      return fd;
    };
    const multipart = async (fd: FormData) => {
      const r = new Request(BASE, { method: "POST", body: fd });
      return { raw: await r.arrayBuffer(), headers: { "content-type": r.headers.get("content-type")! } };
    };
    const fakeOcr = (text: string): OcrProvider => ({
      name: "fake",
      available: true,
      extractText: async () => ({ text, confidence: 0.95, provider: "fake", latencyMs: 1 }),
    });

    it("returns 503 when OCR is disabled", async () => {
      const png = new Uint8Array(readFileSync("tests/fixtures/scam.png"));
      expect((await call(image.POST, await multipart(form(png, "a.png")))).status).toBe(503);
    });

    it("validates the file by content, then OCRs and analyses it", async () => {
      setOcrProvider(fakeOcr("Dear SBI customer your KYC has expired. Update at sbi-kyc-update.xyz and share OTP."));
      const png = new Uint8Array(readFileSync("tests/fixtures/scam.png"));
      const ok = await call(image.POST, { ...(await multipart(form(png, "shot.png"))), user: userA });
      expect(ok.status).toBe(200);
      expect(ok.json.data.inputType).toBe("image");
      expect(ok.json.data.ocr.image).toMatchObject({ width: 900, height: 220 });
      expect(ok.json.data.riskScore).toBeGreaterThanOrEqual(60);

      const spoofed = await call(image.POST, await multipart(form(new TextEncoder().encode("<svg onload=alert(1)>"), "x.png", "image/png")));
      expect(spoofed.status).toBe(415);
      const mismatch = await call(image.POST, await multipart(form(png, "x.jpg", "image/jpeg")));
      expect(mismatch.status).toBe(415);
      expect((await call(image.POST, { body: { image: "base64" } })).status).toBe(415);
      const empty = new FormData();
      empty.append("other", "x");
      expect((await call(image.POST, await multipart(empty))).status).toBe(400);
    });

    it("returns 422 when no text is found", async () => {
      setOcrProvider(fakeOcr("  "));
      const png = new Uint8Array(readFileSync("tests/fixtures/scam.png"));
      expect((await call(image.POST, await multipart(form(png, "a.png")))).status).toBe(422);
    });
  });

  describe("reports and scam intelligence", () => {
    const reported = "URGENT: Your electricity will be disconnected tonight at 9:30pm. Call officer Sharma on 9876543210 immediately.";

    it("requires authentication", async () => {
      expect((await call(reports.POST, { body: { reportType: "message", content: "x", category: "other" } })).status).toBe(401);
    });

    it("aggregates distinct reporters, blocks duplicates, and feeds the detector", async () => {
      const before = await call(message.POST, { body: { message: reported } });
      expect(before.json.data.intel.knownPattern).toBe(false);

      const a = await call(reports.POST, { body: { reportType: "message", content: reported, category: "other" }, user: userA });
      expect(a.status).toBe(201);
      expect(a.json.data.communityReports).toBe(1);
      const dup = await call(reports.POST, { body: { reportType: "message", content: reported, category: "other" }, user: userA });
      expect(dup.status).toBe(409);

      // One reporter is not enough to influence scoring.
      expect((await call(message.POST, { body: { message: reported } })).json.data.intel.knownPattern).toBe(false);

      // A different victim receives the same campaign with a different number.
      const variant = reported.replace("9876543210", "9123456780");
      const b = await call(reports.POST, { body: { reportType: "message", content: variant, category: "other" }, user: userB });
      expect(b.json.data.communityReports).toBe(2);

      const after = await call(message.POST, { body: { message: reported } });
      expect(after.json.data.intel).toMatchObject({ knownPattern: true, reportCount: 2 });
      expect(after.json.data.indicators.map((i: { type: string }) => i.type)).toContain("intel.known_pattern");
      expect(after.json.data.riskScore).toBeGreaterThan(before.json.data.riskScore);
    });

    it("validates report input and analysis ownership", async () => {
      expect((await call(reports.POST, { body: { reportType: "message", content: "x", category: "not-a-category" }, user: userA })).status).toBe(400);
      const theirs = await call(message.POST, { body: { message: "Share your OTP now" }, user: userB });
      const r = await call(reports.POST, {
        body: { reportType: "message", content: "Share your OTP now", category: "credential_theft", analysisId: theirs.json.data.id },
        user: userA,
      });
      expect(r.status).toBe(404);
    });

    it("lists only the caller's reports", async () => {
      const r = await call(reports.GET, { user: userA });
      expect(r.status).toBe(200);
      expect(r.json.data.items.every((i: { preview: string }) => !i.preview.includes("9123456780"))).toBe(true);
    });

    it("registers reported domains and uses them as URL reputation after two reporters", async () => {
      for (const u of [userA, userB]) {
        await call(reports.POST, { body: { reportType: "url", content: "https://pay-refund-portal.com/claim?id=1", category: "phishing" }, user: u });
      }
      const r = await call(urlRoute.POST, { body: { url: "https://pay-refund-portal.com/other" } });
      expect(r.json.data.urls[0].flags.map((f: { id: string }) => f.id)).toContain("intel.reputation");
    });
  });

  describe("settings, stats and privacy controls", () => {
    it("honours storeContentPreview=false and LLM opt-out", async () => {
      expect((await call(settings.PUT, { method: "PUT", body: { retentionDays: 9999 }, user: userB })).status).toBe(400);
      const s = await call(settings.PUT, { method: "PUT", body: { storeContentPreview: false, allowLlmAnalysis: false, retentionDays: 7 }, user: userB });
      expect(s.json.data).toEqual({ storeContentPreview: false, allowLlmAnalysis: false, retentionDays: 7 });
      const r = await call(message.POST, { body: { message: SCAM }, user: userB });
      const row = await prisma.scamAnalysis.findUniqueOrThrow({ where: { id: r.json.data.id } });
      expect(row.contentPreview).toBeNull();
      expect(row.expiresAt.getTime() - Date.now()).toBeLessThan(8 * 86_400_000);
      expect(r.json.data.modelMetadata.llm?.status ?? "disabled").not.toBe("ok");
    });

    it("computes stats from the caller's data only", async () => {
      const a = await call(stats.GET, { user: userA });
      const countA = await prisma.scamAnalysis.count({ where: { userId: userA.id } });
      expect(a.json.data.totalScans).toBe(countA);
      expect(a.json.data.recent.length).toBeLessThanOrEqual(5);
    });

    it("deletes all of the caller's history and nothing else", async () => {
      const bBefore = await prisma.scamAnalysis.count({ where: { userId: userB.id } });
      const r = await call(history.DELETE, { method: "DELETE", user: userA });
      expect(r.json.data.deleted).toBeGreaterThan(0);
      expect(await prisma.scamAnalysis.count({ where: { userId: userA.id } })).toBe(0);
      expect(await prisma.scamAnalysis.count({ where: { userId: userB.id } })).toBe(bBefore);
    });
  });

  describe("Phase 4: remote analysis is per-request opt-in", () => {
    afterAll(() => setAIProvider(null));

    it("no analysisMode → local only: the AI provider is never called", async () => {
      const ai = fakeAI({ riskScore: 99, classification: "scam" });
      setAIProvider(ai);
      const r = await call(message.POST, { body: { message: SCAM } });
      expect(r.status).toBe(200);
      expect(ai.calls).toHaveLength(0);
      expect(r.json.data.remoteAnalysis).toMatchObject({ requested: false, used: false, status: "not_requested", sentChars: 0 });
    });

    it("analysisMode remote-assisted → provider called with minimised text; result marked", async () => {
      const ai = fakeAI({ riskScore: 90, classification: "scam", category: "kyc" });
      setAIProvider(ai);
      const r = await call(message.POST, { body: { message: SCAM, analysisMode: "remote-assisted" } });
      expect(r.status).toBe(200);
      expect(ai.calls).toHaveLength(1);
      expect(r.json.data.remoteAnalysis).toMatchObject({ requested: true, used: true, status: "ok" });
    });

    it("rejects an unknown analysisMode", async () => {
      const r = await call(message.POST, { body: { message: SCAM, analysisMode: "cloud" } });
      expect(r.status).toBe(400);
    });

    it("account opt-out (allowLlmAnalysis=false) overrides a per-request opt-in", async () => {
      await call(settings.PUT, { method: "PUT", body: { allowLlmAnalysis: false }, user: userA });
      const ai = fakeAI({ riskScore: 90 });
      setAIProvider(ai);
      const r = await call(message.POST, { body: { message: SCAM, analysisMode: "remote-assisted" }, user: userA });
      expect(ai.calls).toHaveLength(0);
      expect(r.json.data.remoteAnalysis.used).toBe(false);
      await call(settings.PUT, { method: "PUT", body: { allowLlmAnalysis: true }, user: userA });
    });

    it("health reports llm=opt_in when configured, disabled when LLM_ENABLED=false", async () => {
      setAIProvider(fakeAI({}));
      expect((await call(health.GET as Handler)).json.data.checks.llm).toBe("opt_in");
      process.env.LLM_ENABLED = "false";
      resetEnvCache();
      try {
        expect((await call(health.GET as Handler)).json.data.checks.llm).toBe("disabled");
      } finally {
        process.env.LLM_ENABLED = "true";
        resetEnvCache();
      }
    });
  });

  describe("operations endpoints", () => {

    it("health reports component status without secrets", async () => {
      const r = await call(health.GET as Handler);
      expect(r.status).toBe(200);
      expect(r.json.data.checks.database).toBe("ok");
      expect(JSON.stringify(r.json)).not.toMatch(/postgres(ql)?:\/\//);
    });

    it("metrics and cron require their tokens", async () => {
      expect((await call(metricsRoute.GET as Handler)).status).toBe(404);
      process.env.METRICS_TOKEN = "m".repeat(32);
      process.env.CRON_SECRET = "c".repeat(32);
      resetEnvCache();
      try {
        expect((await call(metricsRoute.GET as Handler, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
        const m = await call(metricsRoute.GET as Handler, { headers: { authorization: `Bearer ${"m".repeat(32)}` } });
        expect(m.status).toBe(200);
        expect(m.json).toContain("scamshield_http_requests_total");

        expect((await call(cron.GET as Handler)).status).toBe(401);
        const expired = await prisma.scamAnalysis.updateMany({ where: { userId: userB.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        const c = await call(cron.GET as Handler, { headers: { authorization: `Bearer ${"c".repeat(32)}` } });
        expect(c.status).toBe(200);
        expect(c.json.data.analyses).toBe(expired.count);
      } finally {
        delete process.env.METRICS_TOKEN;
        delete process.env.CRON_SECRET;
        resetEnvCache();
      }
    });
  });
});
