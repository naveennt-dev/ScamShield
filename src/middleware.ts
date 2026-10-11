import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { buildCsp } from "@/lib/security/csp";
import { isAllowedHost } from "@/lib/security/hosts";

/**
 * Edge middleware:
 *  1. Per-request nonce Content-Security-Policy for pages (scripts need the nonce).
 *  2. Central CORS for /api/*: allow-list from CORS_ALLOWED_ORIGINS, never "*".
 *  0. Host-header allow-list for every page and API route (DNS-rebinding defence; lib/security/hosts).
 *  3. Optimistic auth redirect for app pages (cookie presence only — every page and API route
 *     still validates the session server-side).
 * Never logs cookies or tokens.
 */

const PROTECTED = [/^\/$/, /^\/scan(\/|$)/, /^\/history(\/|$)/, /^\/reports(\/|$)/, /^\/settings(\/|$)/];

function allowedOrigins(): string[] {
  return [process.env.CORS_ALLOWED_ORIGINS ?? "", process.env.APP_URL ?? "", process.env.BETTER_AUTH_URL ?? ""]
    .join(",")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/$/, ""))
    .filter(Boolean);
}

function applyCors(req: NextRequest, res: NextResponse): NextResponse {
  const origin = req.headers.get("origin");
  res.headers.append("Vary", "Origin");
  if (origin && allowedOrigins().includes(origin.toLowerCase())) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Request-Id");
    res.headers.set("Access-Control-Max-Age", "600");
  }
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Behind a trusted proxy the public name arrives in X-Forwarded-Host; otherwise only Host counts.
  const host = (process.env.TRUST_PROXY_HEADERS === "true" ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host");
  if (!isAllowedHost(host)) {
    return new NextResponse(JSON.stringify({ success: false, error: { code: "MISDIRECTED_REQUEST", message: "This service is not available under that name." } }), {
      status: 421,
      headers: { "content-type": "application/json" },
    });
  }

  if (pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") return applyCors(req, new NextResponse(null, { status: 204 }));
    // /api/v1 sets CORS headers in their handlers (withApi); only better-auth's
    // routes need them added here. Setting them twice would produce an invalid header.
    if (pathname.startsWith("/api/auth/")) return applyCors(req, NextResponse.next());
    return NextResponse.next();
  }

  if (PROTECTED.some((re) => re.test(pathname)) && !getSessionCookie(req)) {
    const url = new URL("/auth", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV !== "production";
  const httpsDeployment = (process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "").startsWith("https://");
  const csp = buildCsp(nonce, isDev, !isDev && httpsDeployment);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // Node.js middleware runtime (stable in Next 15.5): better-auth's cookie helpers pull in
  // APIs the Edge runtime lacks.
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt)$).*)"],
};
