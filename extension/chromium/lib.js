// Pure logic of the ScamShield Link Guard extension (no chrome.* calls) — unit-tested with vitest.

export const SERVICE = "http://127.0.0.1:3000";
export const CACHE_MS = 10 * 60_000;
export const CHECK_TIMEOUT_MS = 2500;
/** Verdicts that interrupt navigation with the warning page. */
export const BLOCKING = new Set(["malicious", "high_risk"]);

/** Which navigations are checked: top-level http(s) pages, never our own service or local pages. */
export function shouldCheck(url, frameId) {
  if (frameId !== 0) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost")) return false;
  return true;
}

/** What is sent to the local service: scheme://host/path only (no query string, no fragment). */
export function stripForCheck(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

/** Cache key: a hash of host+path, so the cache never holds a readable browsing history. */
export async function cacheKey(url) {
  const data = new TextEncoder().encode(stripForCheck(url).toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `v:${[...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function freshEntry(entry, now = Date.now()) {
  return entry && typeof entry.at === "number" && now - entry.at < CACHE_MS ? entry : null;
}

/** Ask the ScamShield service on this device (address-only check: nothing leaves the device). */
export async function checkWithService(url, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${SERVICE}/api/v1/analyze/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: stripForCheck(url), analysisMode: "local", inspectBehaviour: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `service answered ${res.status}` };
    const body = await res.json();
    const r = body && body.data;
    if (!r || typeof r.verdict !== "string") return { ok: false, reason: "unexpected answer" };
    return {
      ok: true,
      verdict: r.verdict,
      label: r.verdictLabel,
      host: r.displayHostname || r.hostname || "",
      reasons: (r.evidence || []).filter((e) => e.severity !== "low").slice(0, 3).map((e) => String(e.detail).slice(0, 200)),
    };
  } catch (e) {
    return { ok: false, reason: ctrl.signal.aborted ? "the service did not answer in time" : "the ScamShield service isn't running" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What may be cached for a URL: for pages that are allowed, only the verdict (no site name, no
 * reasons) so the cache can't be read as a browsing history; blocked sites keep what the warning
 * page needs.
 */
export function cacheValue(result) {
  if (!result || !result.ok) return null;
  return BLOCKING.has(result.verdict) ? result : { ok: true, verdict: result.verdict };
}

/** Decide what to do with a verdict. */
export function decide(result) {
  if (!result || !result.ok) return { action: "allow", unprotected: true };
  return BLOCKING.has(result.verdict) ? { action: "warn" } : { action: "allow", unprotected: false };
}

/** Parameters for the warning page (in the URL fragment, never sent anywhere). */
export function warningParams(url, result) {
  return new URLSearchParams({ to: url, host: result.host || "", label: result.label || "High risk", reasons: JSON.stringify(result.reasons || []) }).toString();
}
