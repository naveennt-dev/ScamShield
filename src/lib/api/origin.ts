import { getEnv } from "@/lib/config/env";
import { isLoopbackClient } from "./request-context";

/**
 * CORS + CSRF origin policy.
 *
 * - Same-origin requests are always allowed.
 * - Cross-origin requests are allowed only for origins listed in CORS_ALLOWED_ORIGINS
 *   (exact match, scheme+host+port). There is no wildcard.
 * - State-changing requests (POST/PUT/PATCH/DELETE) carrying a foreign Origin are rejected,
 *   which protects cookie-authenticated endpoints from CSRF.
 */

export function requestOrigin(req: Request): string | null {
  // Forwarded headers are only meaningful (and only trusted) behind a configured proxy.
  const trustProxy = getEnv().TRUST_PROXY_HEADERS;
  const host = (trustProxy ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host");
  if (!host) return null;
  const proto = (trustProxy ? req.headers.get("x-forwarded-proto") : null) ?? new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`.toLowerCase();
}

export function isAllowedOrigin(origin: string, req?: Request): boolean {
  const o = origin.toLowerCase().replace(/\/$/, "");
  if (req) {
    const self = requestOrigin(req);
    if (self && self === o) return true;
    try {
      if (new URL(req.url).origin.toLowerCase() === o) return true;
    } catch {
      // ignore
    }
  }
  const env = getEnv();
  const configured = [...env.CORS_ALLOWED_ORIGINS, env.APP_URL, env.BETTER_AUTH_URL]
    .filter((x): x is string => Boolean(x))
    .map((x) => x.toLowerCase().replace(/\/$/, ""));
  return configured.includes(o);
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Endpoints the local browser extension may call (anonymous, no state change). */
const EXTENSION_PATHS = new Set(["/api/v1/analyze/link"]);
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/**
 * The ScamShield Link Guard extension (Chromium) calls the link scanner on the personal, loopback
 * service. Allowed only when ALLOW_BROWSER_EXTENSION=true, only for EXTENSION_PATHS and only from
 * this machine. Web pages cannot send a chrome-extension:// Origin.
 */
export function isLocalExtensionCall(origin: string, req: Request): boolean {
  if (!getEnv().ALLOW_BROWSER_EXTENSION || !EXTENSION_ORIGIN.test(origin)) return false;
  try {
    return EXTENSION_PATHS.has(new URL(req.url).pathname) && isLoopbackClient(req);
  } catch {
    return false;
  }
}

export function isCrossSiteWriteBlocked(req: Request): boolean {
  if (!UNSAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get("origin");
  if (!origin) {
    // Browsers send Origin on cross-site POSTs; a missing Origin plus Sec-Fetch-Site=cross-site is
    // still treated as cross-site.
    return req.headers.get("sec-fetch-site") === "cross-site";
  }
  return !isAllowedOrigin(origin, req) && !isLocalExtensionCall(origin, req);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !isAllowedOrigin(origin, req)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
