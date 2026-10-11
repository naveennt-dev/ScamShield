import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isAllowedHost } from "@/lib/security/hosts";
import { middleware } from "@/middleware";

/** DNS-rebinding defence: requests must address this service by one of its own names. */

describe("host allow-list", () => {
  it.each(["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "localhost"])("loopback %s is allowed", (h) => {
    expect(isAllowedHost(h, {})).toBe(true);
  });

  it.each(["evil-rebind.example:3000", "127.0.0.1.evil.example", "localhost.evil.example", "", "   "])("foreign host %j is refused", (h) => {
    expect(isAllowedHost(h, {})).toBe(false);
  });

  it("configured app/auth/CORS hosts and ALLOWED_HOSTS (incl. .suffix) are allowed — nothing else", () => {
    const env = { APP_URL: "https://scamshield.example.com", BETTER_AUTH_URL: "https://auth.scamshield.example.com", CORS_ALLOWED_ORIGINS: "https://app.partner.example", ALLOWED_HOSTS: ".vercel.app" };
    for (const h of ["scamshield.example.com", "auth.scamshield.example.com", "app.partner.example", "my-preview.vercel.app"]) expect(isAllowedHost(h, env)).toBe(true);
    for (const h of ["evil.example.com", "scamshield.example.com.evil.net", "vercel.app.evil.net"]) expect(isAllowedHost(h, env)).toBe(false);
  });
});

describe("middleware enforces it on API and pages", () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY_HEADERS;
  });
  const req = (path: string, host: string, extra: Record<string, string> = {}) =>
    new NextRequest(`http://127.0.0.1:3000${path}`, { method: "POST", headers: { host, origin: `http://${host}`, ...extra } });

  it("a rebinding request to the link scanner is refused with 421", async () => {
    const r = middleware(req("/api/v1/analyze/link", "evil-rebind.example:3000"));
    expect(r.status).toBe(421);
  });
  it("a page request with a foreign host is refused", () => {
    expect(middleware(req("/scan/url", "evil-rebind.example:3000")).status).toBe(421);
  });
  it("loopback requests pass through", () => {
    expect(middleware(req("/api/v1/analyze/link", "127.0.0.1:3000")).status).not.toBe(421);
  });
  it("X-Forwarded-Host is only trusted behind a configured proxy", () => {
    expect(middleware(req("/api/v1/health", "127.0.0.1:3000", { "x-forwarded-host": "evil.example" })).status).not.toBe(421);
    process.env.TRUST_PROXY_HEADERS = "true";
    expect(middleware(req("/api/v1/health", "127.0.0.1:3000", { "x-forwarded-host": "evil.example" })).status).toBe(421);
  });
});
