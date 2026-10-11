import { randomUUID, createHash } from "node:crypto";
import { getEnv } from "@/lib/config/env";

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Reuses a well-formed inbound X-Request-Id (e.g. from a load balancer), otherwise generates one. */
export function requestIdFrom(req: Request): string {
  const inbound = req.headers.get("x-request-id");
  return inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
}

/**
 * Client IP for rate limiting. Proxy headers are only trusted when TRUST_PROXY_HEADERS=true
 * (default; correct on Vercel and behind a configured reverse proxy). Set it to false when the
 * app is exposed directly, otherwise clients can spoof X-Forwarded-For.
 */
export function clientIp(req: Request): string {
  if (getEnv().TRUST_PROXY_HEADERS) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim().slice(0, 64);
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim().slice(0, 64);
  }
  return "unknown";
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/**
 * True when the request comes from this machine: the client address AND the Host header are
 * loopback. Only meaningful for a loopback-bound server (the personal stack), which is why the
 * "local" tier that uses it is opt-in (LOCAL_CLIENT_RATE_TIER).
 */
export function isLoopbackClient(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK.has(clientIp(req)) && LOOPBACK.has(host);
}

/** Rate-limit/analytics key that does not store raw IPs. */
export function hashedClientKey(req: Request): string {
  const salt = getEnv().BETTER_AUTH_SECRET ?? "scamshield";
  return createHash("sha256").update(`${salt}|${clientIp(req)}`).digest("hex").slice(0, 32);
}
