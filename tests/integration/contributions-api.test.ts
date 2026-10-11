import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
const session = vi.hoisted(() => ({ current: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => session.current }));
import { prisma } from "@/lib/db/prisma";
import { resetEnvCache } from "@/lib/config/env";
import { setRateLimitStore } from "@/lib/rate-limit";
import { MemoryRateLimitStore } from "@/lib/rate-limit/memory";
import * as contributions from "@/app/api/v1/contributions/route";

/** Opt-in shared-learning contributions endpoint (real PostgreSQL test database). */

const HAS_DB = Boolean(process.env.DATABASE_URL);
let ip = 0;
async function post(body: unknown) {
  const req = new Request("http://localhost:3000/api/v1/contributions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++ip % 250}` },
    body: JSON.stringify(body),
  });
  const res = await contributions.POST(req, { params: Promise.resolve({}) });
  return { status: res.status, json: (await res.json()) as { success: boolean; data?: { id: string; status: string; duplicate: boolean }; error?: { code: string } } };
}

const INSTALL = "6f1c2a6e-1d1b-4c55-9a34-0e3f2f6c9b11";
const body = (patch: Record<string, unknown> = {}) => ({
  installationId: INSTALL,
  text: "Dear customer your KYC expired, share OTP 482913 at https://sbi-kyc.top/verify?id=9 today",
  verdict: "missed_scam",
  system: { riskLevel: "safe", riskScore: 12, category: "kyc" },
  appVersion: "1.0.0",
  ...patch,
});

describe.skipIf(!HAS_DB)("POST /api/v1/contributions", () => {
  beforeEach(async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    process.env.CONTRIBUTIONS_ENABLED = "true";
    resetEnvCache();
    await prisma.contribution.deleteMany({});
  });
  afterAll(async () => {
    delete process.env.CONTRIBUTIONS_ENABLED;
    resetEnvCache();
    await prisma.contribution.deleteMany({});
    await prisma.$disconnect();
  });

  it("is disabled unless the server opts in", async () => {
    delete process.env.CONTRIBUTIONS_ENABLED;
    resetEnvCache();
    const r = await post(body());
    expect(r.status).toBe(403);
    expect(await prisma.contribution.count()).toBe(0);
  });

  it("stores the masked text, quarantined, with the derived label", async () => {
    const r = await post(body());
    expect(r.status).toBe(201);
    expect(r.json.data?.status).toBe("QUARANTINED");
    const row = await prisma.contribution.findUniqueOrThrow({ where: { id: r.json.data!.id } });
    expect(row.label).toBe("scam");
    expect(row.systemLevel).toBe("SAFE");
    for (const s of ["482913", "/verify", "id=9", INSTALL]) expect(JSON.stringify(row)).not.toContain(s);
    expect(row.contributorHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same message from the same installation updates instead of adding weight", async () => {
    await post(body());
    const again = await post(body({ verdict: "unsure", text: "Dear customer your KYC expired, share OTP 111111 at https://sbi-kyc.top/verify?id=10 today" }));
    expect(again.status).toBe(200);
    expect(again.json.data?.duplicate).toBe(true);
    const rows = await prisma.contribution.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBeNull();
  });

  it("rejects invalid input and never stores it", async () => {
    for (const bad of [body({ installationId: "x" }), body({ text: "short" }), body({ verdict: "scam" }), { ...body(), screenshot: "AAAA" }]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(await prisma.contribution.count()).toBe(0);
  });

  it("flags a 'safe' label on an OTP request (poisoning) for review", async () => {
    const r = await post(body({ verdict: "false_positive", system: { riskLevel: "critical", riskScore: 95 } }));
    const row = await prisma.contribution.findUniqueOrThrow({ where: { id: r.json.data!.id } });
    expect(row.label).toBe("safe");
    expect(row.flags).toContain("safe_label_on_critical_request");
  });
});
