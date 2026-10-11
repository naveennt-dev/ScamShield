import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";

/**
 * External URL threat-intelligence providers (URL-level, unlike the domain reputation in
 * lib/url). Each provider is OFF unless its key is configured, is never consulted in on-device-only
 * mode, and receives only `scheme://host/path` (no query string, no fragment, no credentials).
 * Results are cached; calls have a timeout and a per-provider rate limit. A provider that cannot
 * answer is reported as such — never as "not listed".
 */

export type IntelStatus = "listed" | "not_listed" | "error" | "timeout" | "rate_limited" | "not_configured" | "skipped";

export interface UrlIntelResult {
  provider: string;
  status: IntelStatus;
  /** What was sent to the provider (for disclosure); null when nothing was sent. */
  sent: string | null;
  threat: string | null;
  detail: string | null;
  reference: string | null;
  lastUpdated: string | null;
}

export interface UrlThreatProvider {
  readonly name: string;
  readonly label: string;
  configured(): boolean;
  lookup(url: string, signal: AbortSignal): Promise<Omit<UrlIntelResult, "provider" | "sent">>;
}

/** Only the parts of a URL a URL-reputation service needs. */
export function urlForProvider(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const urlhausProvider: UrlThreatProvider = {
  name: "urlhaus",
  label: "URLhaus (abuse.ch)",
  configured: () => Boolean(getEnv().URLHAUS_AUTH_KEY),
  async lookup(url, signal) {
    const res = await fetch("https://urlhaus-api.abuse.ch/v1/url/", {
      method: "POST",
      headers: { "Auth-Key": getEnv().URLHAUS_AUTH_KEY!, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ url }),
      signal,
      redirect: "error",
    });
    if (res.status === 429) return { status: "rate_limited", threat: null, detail: "rate limited by URLhaus", reference: null, lastUpdated: null };
    if (!res.ok) return { status: "error", threat: null, detail: `URLhaus HTTP ${res.status}`, reference: null, lastUpdated: null };
    return parseUrlhaus(await res.json());
  },
};

export function parseUrlhaus(j: unknown): Omit<UrlIntelResult, "provider" | "sent"> {
  const d = j as { query_status?: string; threat?: string; url_status?: string; urlhaus_reference?: string; date_added?: string; tags?: string[] };
  if (d?.query_status === "ok") {
    return {
      status: "listed",
      threat: d.threat ?? "malware_download",
      detail: `Listed by URLhaus as ${String(d.threat ?? "malware distribution").replace(/_/g, " ")}${d.url_status ? ` (currently ${d.url_status})` : ""}${d.tags?.length ? `; tags: ${d.tags.slice(0, 5).join(", ")}` : ""}`,
      reference: d.urlhaus_reference ?? null,
      lastUpdated: d.date_added ?? null,
    };
  }
  if (d?.query_status === "no_results") return { status: "not_listed", threat: null, detail: null, reference: null, lastUpdated: null };
  return { status: "error", threat: null, detail: `URLhaus answered "${String(d?.query_status ?? "unknown")}"`, reference: null, lastUpdated: null };
}

export const phishtankProvider: UrlThreatProvider = {
  name: "phishtank",
  label: "PhishTank",
  configured: () => Boolean(getEnv().PHISHTANK_APP_KEY),
  async lookup(url, signal) {
    const res = await fetch("https://checkurl.phishtank.com/checkurl/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "phishtank/scamshield" },
      body: form({ url, format: "json", app_key: getEnv().PHISHTANK_APP_KEY! }),
      signal,
      redirect: "error",
    });
    if (res.status === 429 || res.status === 509) return { status: "rate_limited", threat: null, detail: "rate limited by PhishTank", reference: null, lastUpdated: null };
    if (!res.ok) return { status: "error", threat: null, detail: `PhishTank HTTP ${res.status}`, reference: null, lastUpdated: null };
    return parsePhishtank(await res.json());
  },
};

export function parsePhishtank(j: unknown): Omit<UrlIntelResult, "provider" | "sent"> {
  const r = (j as { results?: { in_database?: boolean; verified?: boolean | string; valid?: boolean | string; phish_detail_page?: string; verified_at?: string } })?.results;
  if (!r) return { status: "error", threat: null, detail: "unexpected PhishTank answer", reference: null, lastUpdated: null };
  const yes = (v: unknown) => v === true || v === "true" || v === "y";
  if (r.in_database && yes(r.valid) && yes(r.verified)) {
    return { status: "listed", threat: "phishing", detail: "Listed by PhishTank as a verified phishing page", reference: r.phish_detail_page ?? null, lastUpdated: r.verified_at ?? null };
  }
  // Submitted but not (yet) verified as phishing is NOT a listing.
  return { status: "not_listed", threat: null, detail: r.in_database ? "Reported to PhishTank but not verified as phishing" : null, reference: null, lastUpdated: null };
}

export const URL_PROVIDERS: UrlThreatProvider[] = [urlhausProvider, phishtankProvider];

const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { at: number; r: Omit<UrlIntelResult, "provider" | "sent"> }>();
const buckets = new Map<string, number[]>();
const RATE_PER_MIN = 20;

export function clearUrlIntelCache() {
  cache.clear();
  buckets.clear();
}

export async function lookupUrlIntel(
  url: string,
  opts: { networkAllowed: boolean; providers?: UrlThreatProvider[]; timeoutMs?: number; signal?: AbortSignal },
): Promise<UrlIntelResult[]> {
  const providers = opts.providers ?? URL_PROVIDERS;
  const sendable = urlForProvider(url);
  return Promise.all(
    providers.map(async (p): Promise<UrlIntelResult> => {
      const none = (status: IntelStatus, detail: string): UrlIntelResult => ({ provider: p.label, status, sent: null, threat: null, detail, reference: null, lastUpdated: null });
      if (!p.configured()) return none("not_configured", `${p.label} is not configured on this ScamShield service`);
      if (!opts.networkAllowed) return none("skipped", "on-device-only mode: no external lookups");
      if (!sendable) return none("skipped", "not a web address");
      const key = `${p.name}|${sendable}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return { provider: p.label, sent: null, ...hit.r };
      const now = Date.now();
      const recent = (buckets.get(p.name) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= RATE_PER_MIN) return none("rate_limited", `${p.label}: local rate limit reached; try again shortly`);
      recent.push(now);
      buckets.set(p.name, recent);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
      const onAbort = () => ctrl.abort();
      opts.signal?.addEventListener("abort", onAbort);
      try {
        // Hard race: a provider that ignores the abort signal still can't stall the scan.
        const r = await Promise.race([
          p.lookup(sendable, ctrl.signal),
          new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
        ]);
        if (r.status === "listed" || r.status === "not_listed") cache.set(key, { at: Date.now(), r });
        return { provider: p.label, sent: sendable, ...r };
      } catch {
        const timedOut = ctrl.signal.aborted;
        logger.warn("url_intel_failed", { provider: p.name, timedOut });
        return { provider: p.label, status: timedOut ? "timeout" : "error", sent: sendable, threat: null, detail: timedOut ? `${p.label} did not answer in time` : `${p.label} lookup failed`, reference: null, lastUpdated: null };
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    }),
  );
}
