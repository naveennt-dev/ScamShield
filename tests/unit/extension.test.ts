import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { isCrossSiteWriteBlocked } from "@/lib/api/origin";
// The extension's logic is plain JavaScript shared with the browser.
import * as lib from "../../extension/chromium/lib.js";

/** ScamShield Link Guard (Chromium MV3 extension): decision logic and the service's origin rule. */

describe("which navigations are checked", () => {
  it.each([
    ["https://example.com/", 0, true],
    ["http://phish.top/login", 0, true],
    ["https://example.com/", 3, false], // sub-frames: not intercepted
    ["chrome://settings", 0, false],
    ["file:///Users/x/a.html", 0, false],
    ["http://127.0.0.1:3000/", 0, false],
    ["http://localhost:8080/", 0, false],
    ["not a url", 0, false],
  ])("%s (frame %i) → %s", (url, frame, expected) => {
    expect(lib.shouldCheck(url, frame)).toBe(expected);
  });
});

describe("privacy", () => {
  it("sends only scheme://host/path to the local service, and the cache key is a hash", async () => {
    expect(lib.stripForCheck("https://bank.example.com/reset?token=SECRET#frag")).toBe("https://bank.example.com/reset");
    const key = await lib.cacheKey("https://bank.example.com/reset?token=SECRET");
    expect(key).toMatch(/^v:[0-9a-f]{32}$/);
    expect(key).toBe(await lib.cacheKey("https://BANK.example.com/reset?other=1"));
  });
});

describe("talking to the service", () => {
  const fakeFetch = (status: number, body: unknown, delayMs = 0) => async (_u: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify(body), { status })), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  it("warns for high risk / malicious, allows the rest", async () => {
    let sent = "";
    const r = await lib.checkWithService("https://paypa1-login.top/x?session=S", async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ success: true, data: { verdict: "high_risk", verdictLabel: "High risk", displayHostname: "paypa1-login.top", evidence: [{ severity: "high", detail: "Looks like PayPal" }, { severity: "low", detail: "minor" }] } }));
    });
    expect(JSON.parse(sent)).toEqual({ url: "https://paypa1-login.top/x", analysisMode: "local", inspectBehaviour: false });
    expect(lib.decide(r)).toEqual({ action: "warn" });
    expect(r.reasons).toEqual(["Looks like PayPal"]);
    for (const v of ["suspicious", "no_known_threat", "inconclusive"]) {
      expect(lib.decide({ ok: true, verdict: v }).action).toBe("allow");
    }
    expect(lib.decide({ ok: true, verdict: "malicious" }).action).toBe("warn");
  });

  it("service down / slow / broken → not checked (shown as unprotected), never 'safe'", async () => {
    const down = await lib.checkWithService("https://a.com/", async () => { throw new TypeError("fetch failed"); });
    expect(down.ok).toBe(false);
    expect(lib.decide(down)).toEqual({ action: "allow", unprotected: true });
    const slow = await lib.checkWithService("https://a.com/", fakeFetch(200, {}, 10_000));
    expect(slow).toMatchObject({ ok: false, reason: "the service did not answer in time" });
    expect((await lib.checkWithService("https://a.com/", fakeFetch(500, {}))).ok).toBe(false);
    expect((await lib.checkWithService("https://a.com/", fakeFetch(200, { success: true, data: {} }))).ok).toBe(false);
  }, 10_000);

  it("allowed pages are cached without the site name; blocked sites keep what the warning needs", () => {
    expect(lib.cacheValue({ ok: true, verdict: "no_known_threat", host: "my-bank.com", reasons: ["x"] })).toEqual({ ok: true, verdict: "no_known_threat" });
    expect(lib.cacheValue({ ok: true, verdict: "high_risk", host: "paypa1.top", reasons: ["y"] })).toMatchObject({ host: "paypa1.top" });
    expect(lib.cacheValue({ ok: false })).toBeNull();
  });

  it("cache entries expire", () => {
    expect(lib.freshEntry({ at: Date.now() })).toBeTruthy();
    expect(lib.freshEntry({ at: Date.now() - lib.CACHE_MS - 1 })).toBeNull();
    expect(lib.freshEntry(undefined)).toBeNull();
  });
});

describe("service origin rule for the extension", () => {
  afterEach(() => {
    delete process.env.ALLOW_BROWSER_EXTENSION;
    resetEnvCache();
  });
  const req = (path: string, origin: string, ip = "127.0.0.1", host = "127.0.0.1:3000") =>
    new Request(`http://${host}${path}`, { method: "POST", headers: { origin, host, "x-forwarded-for": ip } });
  const EXT = `chrome-extension://${"a".repeat(32)}`;

  it("blocked unless enabled, and only for the link scanner from this machine", () => {
    expect(isCrossSiteWriteBlocked(req("/api/v1/analyze/link", EXT))).toBe(true);
    process.env.ALLOW_BROWSER_EXTENSION = "true";
    resetEnvCache();
    expect(isCrossSiteWriteBlocked(req("/api/v1/analyze/link", EXT))).toBe(false);
    expect(isCrossSiteWriteBlocked(req("/api/v1/reports", EXT))).toBe(true);
    expect(isCrossSiteWriteBlocked(req("/api/v1/contributions", EXT))).toBe(true);
    expect(isCrossSiteWriteBlocked(req("/api/v1/analyze/link", EXT, "203.0.113.9", "scamshield.example.com"))).toBe(true);
    expect(isCrossSiteWriteBlocked(req("/api/v1/analyze/link", "https://evil.example"))).toBe(true);
    expect(isCrossSiteWriteBlocked(req("/api/v1/analyze/link", "chrome-extension://not-an-id"))).toBe(true);
  });
});
