import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { setRateLimitStore } from "@/lib/rate-limit";
import { MemoryRateLimitStore } from "@/lib/rate-limit/memory";
import * as message from "@/app/api/v1/analyze/message/route";

/**
 * Phase 6 — the "local" rate-limit tier (personal Mac app on a loopback-only service).
 * Anonymous limits (5/min, 30/day) made the Mac app stop working after 30 scans a day.
 */
const call = (xff: string, host: string) =>
  message.POST(
    new Request(`http://${host}/api/v1/analyze/message`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": xff, host },
      body: JSON.stringify({ message: "Lunch at 1 tomorrow?" }),
    }),
  );

async function statuses(n: number, xff: string, host: string) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await call(xff, host)).status);
  return out;
}

beforeEach(() => setRateLimitStore(new MemoryRateLimitStore()));
afterEach(() => {
  delete process.env.LOCAL_CLIENT_RATE_TIER;
  resetEnvCache();
});

describe("local-client rate-limit tier", () => {
  it("opt-in + loopback client + loopback Host → well above the anonymous limit", async () => {
    process.env.LOCAL_CLIENT_RATE_TIER = "true";
    resetEnvCache();
    expect(await statuses(12, "127.0.0.1", "127.0.0.1:3000")).toEqual(Array(12).fill(200));
  });

  it("still bounded: the per-minute local limit is enforced", async () => {
    process.env.LOCAL_CLIENT_RATE_TIER = "true";
    resetEnvCache();
    const s = await statuses(61, "::1", "localhost:3000");
    expect(s.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(s[60]).toBe(429);
  });

  it.each([
    ["non-loopback client", "198.51.100.7", "127.0.0.1:3000"],
    ["loopback client but foreign Host", "127.0.0.1", "scamshield.example.com"],
  ])("%s → anonymous limits apply", async (_n, xff, host) => {
    process.env.LOCAL_CLIENT_RATE_TIER = "true";
    resetEnvCache();
    const s = await statuses(6, xff, host);
    expect(s.slice(0, 5)).toEqual(Array(5).fill(200));
    expect(s[5]).toBe(429);
  });

  it("off by default: loopback clients get anonymous limits", async () => {
    resetEnvCache();
    const s = await statuses(6, "127.0.0.1", "127.0.0.1:3000");
    expect(s[5]).toBe(429);
  });
});
