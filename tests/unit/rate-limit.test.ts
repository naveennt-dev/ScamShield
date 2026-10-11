import { afterEach, describe, expect, it } from "vitest";
import { checkRateLimit, POLICIES, rateLimitHeaders, setRateLimitStore } from "@/lib/rate-limit";
import { MemoryRateLimitStore } from "@/lib/rate-limit/memory";
import type { RateLimitStore } from "@/lib/rate-limit/types";

afterEach(() => setRateLimitStore(null));

describe("rate limiting", () => {
  it("enforces the per-minute anonymous limit and resets after the window", async () => {
    let now = 0;
    setRateLimitStore(new MemoryRateLimitStore(() => now));
    const limit = POLICIES.analyze_message.anonymous[0].limit;
    for (let i = 0; i < limit; i++) expect((await checkRateLimit("analyze_message", "anonymous", "ip:a")).allowed).toBe(true);
    const blocked = await checkRateLimit("analyze_message", "anonymous", "ip:a");
    expect(blocked.allowed).toBe(false);
    expect(rateLimitHeaders(blocked)["Retry-After"]).toBeDefined();
    now += 61_000;
    expect((await checkRateLimit("analyze_message", "anonymous", "ip:a")).allowed).toBe(true);
  });

  it("gives authenticated users higher limits and isolates identities", async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    expect(POLICIES.analyze_message.authenticated[0].limit).toBeGreaterThan(POLICIES.analyze_message.anonymous[0].limit);
    for (let i = 0; i < 5; i++) await checkRateLimit("analyze_message", "anonymous", "ip:x");
    expect((await checkRateLimit("analyze_message", "anonymous", "ip:y")).allowed).toBe(true);
  });

  it("never allows anonymous reports", async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    expect((await checkRateLimit("report", "anonymous", "ip:z")).allowed).toBe(false);
  });

  it("degrades to an in-process limiter when the shared store fails", async () => {
    const broken: RateLimitStore = { name: "broken", hit: async () => Promise.reject(new Error("redis down")) };
    setRateLimitStore(broken);
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await checkRateLimit("analyze_url", "anonymous", "ip:fallback")).allowed);
    expect(results.filter((r) => !r).length).toBeGreaterThan(0);
  });
});
