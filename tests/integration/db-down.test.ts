import { describe, expect, it } from "vitest";

/**
 * Phase 6 — the database is optional for scanning. With PostgreSQL unreachable, analysis must still
 * work and health must say "degraded" (not "down"), because the Mac app refuses to scan when the
 * service reports "down".
 */
describe("database unavailable", () => {
  it("analysis works and health is degraded, not down", async () => {
    process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1";
    const { resetEnvCache } = await import("@/lib/config/env");
    resetEnvCache();
    const health = await import("@/app/api/v1/health/route");
    const message = await import("@/app/api/v1/analyze/message/route");

    const h = await health.GET(new Request("http://localhost/api/v1/health"));
    const hb = await h.json();
    expect(h.status).toBe(200);
    expect(hb.data.checks.database).toBe("down");
    expect(hb.data.status).toBe("degraded");

    const r = await message.POST(
      new Request("http://localhost/api/v1/analyze/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ message: "Your KYC expired. Share the OTP now at sbi-kyc-update.xyz/login" }),
      }),
    );
    const rb = await r.json();
    expect(r.status).toBe(200);
    expect(["high", "critical"]).toContain(rb.data.riskLevel);
  }, 20_000);
});
