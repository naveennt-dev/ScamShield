/**
 * Host-header allow-list (DNS-rebinding defence).
 *
 * A malicious website can make its own domain resolve to 127.0.0.1 ("DNS rebinding"); the user's
 * browser then treats requests to the local ScamShield service as same-origin, because the Origin
 * and the Host header both carry the attacker's name. Rejecting any Host that is not a name this
 * service is meant to be reached by closes that hole for every page and API route.
 *
 * Allowed: loopback names (127.0.0.1, localhost, [::1] — any port), the hosts of APP_URL,
 * BETTER_AUTH_URL and CORS_ALLOWED_ORIGINS, and ALLOWED_HOSTS (comma-separated; a leading "." means
 * "this domain and its subdomains", e.g. ".vercel.app").
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function allowedHostPatterns(env: Record<string, string | undefined> = process.env): string[] {
  const fromUrls = [env.APP_URL, env.BETTER_AUTH_URL, ...(env.CORS_ALLOWED_ORIGINS ?? "").split(",")]
    .map((v) => (v ? hostOf(v.trim()) : null))
    .filter((h): h is string => Boolean(h));
  const extra = (env.ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...fromUrls, ...extra])];
}

export function isAllowedHost(hostHeader: string | null, env: Record<string, string | undefined> = process.env): boolean {
  if (!hostHeader) return false;
  const host = hostOf(hostHeader.trim());
  if (!host) return false;
  if (LOOPBACK.has(host)) return true;
  return allowedHostPatterns(env).some((p) => (p.startsWith(".") ? host === p.slice(1) || host.endsWith(p) : host === p));
}
