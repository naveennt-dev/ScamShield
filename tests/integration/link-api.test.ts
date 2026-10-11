import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
const session = vi.hoisted(() => ({ current: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => session.current }));
import { resetEnvCache } from "@/lib/config/env";
import { setRateLimitStore } from "@/lib/rate-limit";
import { MemoryRateLimitStore } from "@/lib/rate-limit/memory";
import * as link from "@/app/api/v1/analyze/link/route";

/** POST /api/v1/analyze/link through the real route (local mode: no outbound requests). */

const call = async (body: unknown, ip = "198.51.100.7") => {
  const req = new Request("http://localhost:3000/api/v1/analyze/link", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, host: "localhost:3000" },
    body: JSON.stringify(body),
  });
  const res = await link.POST(req, { params: Promise.resolve({}) });
  return { status: res.status, json: (await res.json()) as { success: boolean; data?: { verdict: string; coverage: Array<{ id: string; status: string }> }; error?: { code: string } } };
};

beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore());
  resetEnvCache();
});

describe("link scan route", () => {
  it("scans in on-device-only mode and reports skipped network checks", async () => {
    const r = await call({ url: "https://paypa1-secure-login.top/verify", analysisMode: "local" });
    expect(r.status).toBe(200);
    expect(r.json.data?.verdict).toBe("high_risk");
    expect(r.json.data?.coverage.find((c) => c.id === "page")?.status).toBe("skipped");
  });

  it("rejects unknown fields and oversize URLs", async () => {
    expect((await call({ url: "a.com", followRedirects: true })).status).toBe(400);
    expect((await call({ url: `https://a.com/${"x".repeat(5000)}` })).status).toBe(400);
  });

  it("page inspections have their own, much tighter limit (anonymous: 2/min)", async () => {
    const ask = () => call({ url: "https://example.com/", analysisMode: "local", inspectBehaviour: true }, "198.51.100.9");
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    const third = await ask();
    expect(third.status).toBe(429);
    // ordinary scans from the same client are not affected
    expect((await call({ url: "https://example.com/", analysisMode: "local" }, "198.51.100.9")).status).toBe(200);
  });
});
