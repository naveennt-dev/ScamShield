/**
 * URL privacy: what may be stored or sent to third parties.
 *
 * Query parameters can carry session tokens, one-time codes, e-mail addresses or phone numbers.
 * `redactUrl` keeps the scheme, host and path (path segments that look like secrets are masked),
 * drops tracking parameters, and replaces every other parameter VALUE with "…" (names are kept so
 * the shape of the link is still visible). Fragments are removed. Credentials are removed.
 */

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|yclid|_hsenc|_hsmi|ref_src|si)$/i;

/** Path segments that look like tokens/IDs (long random strings, e-mails, long digit runs). */
function maskSegment(seg: string): string {
  let d: string;
  try {
    d = decodeURIComponent(seg);
  } catch {
    d = seg;
  }
  if (/@/.test(d)) return "…";
  if (/\d{6,}/.test(d)) return "…";
  if (d.length >= 24 && /^[A-Za-z0-9_=+\-.~]+$/.test(d) && /\d/.test(d) && /[A-Za-z]/.test(d)) return "…";
  return seg;
}

export interface RedactedUrl {
  url: string;
  /** True when anything was removed or masked. */
  changed: boolean;
}

export function redactUrl(raw: string): RedactedUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: raw.replace(/[?#].*$/, ""), changed: /[?#]/.test(raw) };
  }
  const before = u.toString();
  u.username = "";
  u.password = "";
  u.hash = "";
  u.pathname = u.pathname.split("/").map(maskSegment).join("/");
  const kept = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (TRACKING.test(k)) continue;
    kept.append(k, v ? "…" : "");
  }
  u.search = kept.toString() ? `?${kept.toString().replace(/%E2%80%A6/g, "…")}` : "";
  const after = u.toString().replace(/%E2%80%A6/g, "…");
  return { url: after, changed: after !== before };
}

/** Host only — the minimum a third party needs for a reputation check by host. */
export function hostOnly(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return "";
  }
}
