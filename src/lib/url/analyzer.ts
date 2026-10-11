import { domainToUnicode } from "node:url";
import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";
import type { UrlFinding } from "@/lib/schemas/analysis";
import {
  BRAND_DOMAINS,
  EXECUTABLE_EXT,
  FREE_HOSTING_SUFFIXES,
  LINK_WORD_GROUPS,
  SUSPICIOUS_TLDS,
  TRUSTED_SUFFIXES,
  URL_SHORTENERS,
  WATCH_TLDS,
} from "./data";
import { foldHomoglyphs } from "@/lib/text/homoglyphs";
import { isBlockedIp } from "./safety";
import type { DomainReputation, UrlFlag } from "./types";

/**
 * Static (no-network) URL risk analysis. Produces explainable flags and a 0–100 score combined
 * with a noisy-OR so independent weak signals accumulate without exceeding 100.
 */

const DESKELETON: Array<[RegExp, string]> = [
  [/0/g, "o"],
  [/1/g, "l"],
  [/3/g, "e"],
  [/4/g, "a"],
  [/5/g, "s"],
  [/7/g, "t"],
  [/8/g, "b"],
  [/rn/g, "m"],
  [/vv/g, "w"],
];

function deskeleton(s: string): string {
  return DESKELETON.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

const OFFICIAL_DOMAINS = new Set(Object.values(BRAND_DOMAINS).flat());
const OFFICIAL_LABELS = new Map<string, string>(); // label → brand
for (const [brand, domains] of Object.entries(BRAND_DOMAINS)) {
  for (const d of domains) {
    const label = parseDomain(d).domainWithoutSuffix;
    if (label && label.length >= 4) OFFICIAL_LABELS.set(label, brand);
  }
}

export function isOfficialBrandHost(hostname: string): boolean {
  const info = parseDomain(hostname);
  if (TRUSTED_SUFFIXES.some((s) => hostMatchesSuffix(hostname, s))) return true;
  return Boolean(info.domain && (OFFICIAL_DOMAINS.has(info.domain) || OFFICIAL_DOMAINS.has(hostname)));
}

function brandFlags(hostname: string, registrable: string | null, labelPart: string): UrlFlag[] {
  const flags: UrlFlag[] = [];
  if (isOfficialBrandHost(hostname)) return flags;

  const tokens = labelPart.split(/[-.]/).filter(Boolean);
  for (const brand of Object.keys(BRAND_DOMAINS)) {
    const hit = tokens.some((t) => t === brand || (brand.length >= 4 && t.includes(brand)));
    if (hit) {
      flags.push({
        id: "host.brand_impersonation",
        severity: "high",
        weight: 0.55,
        detail: `Uses the name "${brand}" but is not an official ${brand} domain (${registrable ?? hostname})`,
      });
      return flags;
    }
  }

  const main = parseDomain(hostname).domainWithoutSuffix ?? "";
  if (main) {
    // The whole name AND each hyphen/dot-separated part ("paypa1-secure-login" → "paypa1").
    const parts = [main, ...labelPart.split(/[-.]/).filter((t) => t.length >= 4 && t !== main)];
    outer: for (const part of parts) {
      const skeleton = deskeleton(part);
      for (const [label, brand] of OFFICIAL_LABELS) {
        if (part === label) continue;
        if (skeleton === label || (label.length >= 5 && part.length >= 5 && levenshtein(part, label) === 1)) {
          flags.push({
            id: "host.typosquat",
            severity: "high",
            weight: 0.6,
            detail: part === main
              ? `"${registrable}" looks like a misspelling of an official ${brand} domain`
              : `"${part}" in ${registrable ?? hostname} looks like a misspelling of ${brand}`,
          });
          break outer;
        }
      }
    }
  }
  return flags;
}

function noisyOr(weights: number[]): number {
  return Math.round(100 * (1 - weights.reduce((acc, w) => acc * (1 - Math.min(0.99, Math.max(0, w))), 1)));
}

export function analyzeUrlStatic(
  rawUrl: string,
  reputation: DomainReputation[] = [],
  opts: { obfuscated?: boolean; checkedBy?: string[] } = {},
): UrlFinding {
  const flags: UrlFlag[] = [];
  if (opts.obfuscated) {
    flags.push({
      id: "url.obfuscated",
      severity: "medium",
      weight: 0.3,
      detail: "The link was written in a disguised form (e.g. example[.]com) — often done to slip past filters",
    });
  }
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return {
      url: rawUrl.slice(0, 500),
      hostname: "",
      registrableDomain: null,
      riskScore: 40,
      flags: [{ id: "url.unparsable", severity: "medium", detail: "The link is malformed and could not be parsed" }],
      reputation: "unknown",
    };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    flags.push({
      id: "scheme.dangerous",
      severity: "high",
      weight: 0.8,
      detail: `Uses the "${u.protocol}" scheme, which can run code or embed content`,
    });
  } else if (u.protocol === "http:") {
    flags.push({ id: "scheme.no_tls", severity: "low", weight: 0.1, detail: "Does not use HTTPS" });
  }

  const hostname = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const info = parseDomain(hostname);
  const registrable = info.domain ?? null;
  const labelPart = info.publicSuffix && hostname.endsWith(info.publicSuffix)
    ? hostname.slice(0, -(info.publicSuffix.length + 1))
    : hostname;

  if (u.username || u.password || /^[a-z]+:\/\/[^/]*@/i.test(rawUrl)) {
    flags.push({
      id: "url.userinfo",
      severity: "high",
      weight: 0.5,
      detail: "Contains an '@' in the address, a trick to hide the real destination",
    });
  }

  if (isIP(hostname)) {
    flags.push({ id: "host.ip_literal", severity: "high", weight: 0.45, detail: "Uses a raw IP address instead of a domain name" });
    const authority = rawUrl.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].replace(/^.*@/, "").replace(/:\d+$/, "");
    if (isIP(hostname) === 4 && authority !== hostname) {
      flags.push({ id: "host.obfuscated_ip", severity: "high", weight: 0.55, detail: "IP address is written in an obfuscated (hex/decimal) form" });
    }
    if (isBlockedIp(hostname)) {
      flags.push({
        id: "host.internal_target",
        severity: "high",
        weight: 0.5,
        detail: "Points at a private/internal network address — never legitimate in a message",
      });
    }
  } else if (hostname) {
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
      flags.push({ id: "host.internal_target", severity: "high", weight: 0.5, detail: "Points at an internal hostname" });
    }
    const isPunycode = hostname.split(".").some((l) => l.startsWith("xn--"));
    if (isPunycode) {
      const unicode = domainToUnicode(hostname);
      flags.push({
        id: "host.punycode",
        severity: "medium",
        weight: 0.35,
        detail: `Uses internationalised characters that can imitate another site (${unicode})`,
      });
      // Compare the look-alike (Latin-folded) form against brands: "pаypal" (Cyrillic а) → "paypal".
      const folded = foldHomoglyphs(unicode).toLowerCase();
      const foldedInfo = parseDomain(folded);
      const foldedLabels = foldedInfo.publicSuffix ? folded.slice(0, -(foldedInfo.publicSuffix.length + 1)) : folded;
      const homographFlags: UrlFlag[] = isOfficialBrandHost(folded)
        ? [{ id: "host.homograph", severity: "high", weight: 0.7, detail: `imitates the official site ${folded}` }]
        : brandFlags(folded, foldedInfo.domain ?? folded, foldedLabels);
      flags.push(...homographFlags.map((f) => ({ ...f, id: "host.homograph", weight: 0.7, detail: `Look-alike of a real brand: ${f.detail}` })));
    } else {
      flags.push(...brandFlags(hostname, registrable, labelPart));
    }

    if (URL_SHORTENERS.has(hostname) || (registrable && URL_SHORTENERS.has(registrable))) {
      flags.push({ id: "host.shortener", severity: "medium", weight: 0.25, detail: "Uses a link shortener that hides the real destination" });
    }
    const freeHost = FREE_HOSTING_SUFFIXES.find((s) => hostMatchesSuffix(hostname, s));
    if (freeHost) {
      flags.push({
        id: "host.free_hosting",
        severity: "medium",
        weight: 0.2,
        detail: `Hosted on a free/temporary hosting service (${freeHost})`,
      });
    }
    const tld = info.publicSuffix?.split(".").pop() ?? "";
    if (SUSPICIOUS_TLDS.has(tld)) {
      flags.push({ id: "host.suspicious_tld", severity: "medium", weight: 0.25, detail: `Uses the ".${tld}" ending, frequently abused by scam sites` });
    } else if (WATCH_TLDS.has(tld)) {
      flags.push({ id: "host.watch_tld", severity: "low", weight: 0.1, detail: `Uses the ".${tld}" ending, common in scam campaigns` });
    }
    if (info.subdomain && info.subdomain.split(".").length >= 3) {
      flags.push({ id: "host.many_subdomains", severity: "low", weight: 0.15, detail: "Has an unusually deep chain of subdomains" });
    }
    const main = info.domainWithoutSuffix ?? "";
    if (!isPunycode && ((main.match(/-/g)?.length ?? 0) >= 2 || main.length > 30)) {
      flags.push({ id: "host.complex_domain", severity: "low", weight: 0.15, detail: "Domain name is long or has many hyphens" });
    }
    if (!isPunycode && /\d/.test(main) && /[a-z]/.test(main) && !isOfficialBrandHost(hostname)) {
      flags.push({ id: "host.digits_in_domain", severity: "low", weight: 0.06, detail: "Domain name mixes letters and digits" });
    }
  }

  if (u.port && u.port !== "80" && u.port !== "443") {
    flags.push({ id: "url.nonstandard_port", severity: "medium", weight: 0.2, detail: `Uses an unusual port (${u.port})` });
  }
  if (rawUrl.length > 120) {
    flags.push({ id: "url.long", severity: "low", weight: 0.08, detail: "The address is unusually long" });
  }
  const pathAndQuery = `${u.pathname}${u.search}`;
  if (EXECUTABLE_EXT.test(u.pathname)) {
    flags.push({ id: "path.executable", severity: "high", weight: 0.55, detail: "Links directly to an app/program file that could install malware" });
  }
  if (!(hostname && isOfficialBrandHost(hostname))) {
    // Whole words only, and name exactly which words were found.
    const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const hostWords = words(labelPart);
    let pathText = u.pathname;
    try {
      pathText = decodeURIComponent(u.pathname);
    } catch {
      /* keep raw */
    }
    const pathWords = words(pathText);
    for (const g of LINK_WORD_GROUPS) {
      const inHost = g.words.filter((w) => hostWords.has(w));
      const inPath = g.words.filter((w) => pathWords.has(w) && !inHost.includes(w));
      const quote = (ws: string[]) => ws.map((w) => `"${w}"`).join(", ");
      if (inHost.length) {
        // Real companies don't put "kyc"/"verify"/"refund" in their website NAME.
        flags.push({
          id: "path.sensitive_keywords",
          severity: "medium",
          weight: 0.3,
          detail: `The website name contains ${quote(inHost)}${inPath.length ? ` and the link's path ${quote(inPath)}` : ""} — it ${g.why}`,
        });
      } else if (inPath.length && flags.some((f) => f.severity !== "low")) {
        // A "/login" or "/claim" path is normal on real sites; it only counts next to other warning signs.
        flags.push({
          id: "path.sensitive_keywords",
          severity: "low",
          weight: 0.12,
          detail: `The link's path contains ${inPath.map((w) => `"${w}"`).join(", ")} — it ${g.why}`,
        });
      }
    }
  }
  if ((pathAndQuery.match(/%[0-9a-f]{2}/gi)?.length ?? 0) > 10 || /%25[0-9a-f]{2}/i.test(pathAndQuery)) {
    flags.push({ id: "url.encoded_obfuscation", severity: "low", weight: 0.15, detail: "Heavily encoded address that may hide its content" });
  }

  let reputationStatus: UrlFinding["reputation"] = "unknown";
  const RANK = { unknown: 0, benign_reports: 1, suspicious: 2, confirmed_malicious: 3 } as const;
  const matched: DomainReputation[] = [];
  for (const rep of reputation) {
    if (registrable && (rep.domain === registrable || rep.domain === hostname)) {
      matched.push(rep);
      const status = rep.status ?? "suspicious";
      if (RANK[status] > RANK[reputationStatus]) reputationStatus = status;
      if (status === "benign_reports" || rep.maliciousConfidence <= 0) continue; // never a risk signal
      flags.push({
        id: "intel.reputation",
        severity: rep.maliciousConfidence >= 0.6 ? "high" : "medium",
        weight: Math.min(0.85, rep.maliciousConfidence),
        detail: rep.detail,
      });
    }
  }

  return {
    url: rawUrl.slice(0, 500),
    hostname,
    registrableDomain: registrable,
    riskScore: noisyOr(flags.map((f) => f.weight)),
    flags: flags.map(({ id, severity, detail }) => ({ id, severity, detail })),
    reputation: reputationStatus,
    intel: {
      checked: (opts.checkedBy?.length ?? 0) > 0,
      checkedBy: opts.checkedBy ?? [],
      sources: [...new Set(matched.map((m) => m.source))],
      evidence: matched.map((m) => m.detail).slice(0, 5),
      confidence: matched.length > 0 ? Math.max(...matched.map((m) => m.maliciousConfidence)) : null,
      lastUpdated: matched.map((m) => m.lastUpdated).filter((d): d is string => Boolean(d)).sort().at(-1) ?? null,
    },
  };
}
