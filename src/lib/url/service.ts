import { parse as parseDomain } from "tldts";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import type { UrlFinding } from "@/lib/schemas/analysis";
import { analyzeUrlStatic } from "./analyzer";
import { resolveRedirects } from "./fetcher";
import type { DomainReputation, DomainReputationProvider } from "./types";

/**
 * Orchestrates URL analysis: static heuristics + reputation providers + (opt-in) SSRF-safe
 * redirect resolution. Failures in enrichment never fail the analysis; they are logged/metered.
 */

export interface UrlAnalysisOptions {
  followRedirects?: boolean;
  /** URLs that appeared in obfuscated ("defanged") form in the text. */
  obfuscatedUrls?: ReadonlySet<string>;
  reputationProviders?: DomainReputationProvider[];
  requestId?: string;
}

/** Short-lived cache of reputation answers (per provider and domain), so repeated scans of the
 *  same link don't re-query. New intelligence takes effect within REPUTATION_CACHE_TTL_MS. */
export const REPUTATION_CACHE_TTL_MS = 5 * 60_000;
const REPUTATION_CACHE_MAX = 2000;
const reputationCache = new Map<string, { at: number; records: DomainReputation[] }>();

const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

export function clearReputationCache(): void {
  reputationCache.clear();
}

export interface ReputationLookup {
  records: DomainReputation[];
  /** Providers that actually answered for these domains (cached or live). */
  checkedBy: string[];
}

async function lookupReputation(
  domains: string[],
  providers: DomainReputationProvider[],
  requestId?: string,
  now = Date.now(),
): Promise<ReputationLookup> {
  const usable = providers.filter((p) => p.isAvailable?.() ?? true);
  if (domains.length === 0 || usable.length === 0) return { records: [], checkedBy: [] };
  const records: DomainReputation[] = [];
  const checkedBy: string[] = [];
  await Promise.all(
    usable.map(async (p) => {
      const fresh = (d: string) => {
        const hit = reputationCache.get(`${p.name}|${d}`);
        return hit && now - hit.at < REPUTATION_CACHE_TTL_MS ? hit : null;
      };
      const missing = domains.filter((d) => !fresh(d));
      try {
        const got = missing.length > 0 ? await p.lookup(missing) : [];
        for (const d of missing) {
          if (reputationCache.size >= REPUTATION_CACHE_MAX) reputationCache.delete(reputationCache.keys().next().value!);
          reputationCache.set(`${p.name}|${d}`, { at: now, records: got.filter((r) => sameSite(r.domain, d)) });
        }
        // A record that matches none of the requested domains is still returned (not cached).
        records.push(...got.filter((r) => !missing.some((d) => sameSite(r.domain, d))));
        for (const d of domains) records.push(...(fresh(d)?.records ?? reputationCache.get(`${p.name}|${d}`)?.records ?? []));
        checkedBy.push(p.name);
      } catch (error) {
        metrics.urlAnalysisFailure(`reputation_${p.name}`);
        logger.warn("reputation_lookup_failed", { requestId, provider: p.name, error });
      }
    }),
  );
  return { records, checkedBy };
}

export async function analyzeUrls(urls: string[], opts: UrlAnalysisOptions = {}): Promise<UrlFinding[]> {
  const env = getEnv();
  const domains = [
    ...new Set(
      urls
        .map((u) => {
          try {
            return parseDomain(new URL(u).hostname).domain;
          } catch {
            return null;
          }
        })
        .filter((d): d is string => Boolean(d)),
    ),
  ];
  const { records: reputation, checkedBy } = await lookupReputation(domains, opts.reputationProviders ?? [], opts.requestId);
  const findings = urls.map((u) => analyzeUrlStatic(u, reputation, { obfuscated: opts.obfuscatedUrls?.has(u) ?? false, checkedBy }));

  if (!opts.followRedirects || !env.URL_FETCH_ENABLED) return findings;

  // Redirect resolution is bounded to the first 3 URLs to cap outbound work per request.
  for (const finding of findings.slice(0, 3)) {
    if (finding.flags.some((f) => f.id === "host.internal_target" || f.id === "scheme.dangerous")) continue;
    try {
      const res = await resolveRedirects(finding.url, {
        maxRedirects: env.URL_FETCH_MAX_REDIRECTS,
        timeoutMs: env.URL_FETCH_TIMEOUT_MS,
        maxBytes: env.URL_FETCH_MAX_BYTES,
      });
      finding.redirectChain = res.chain;
      finding.finalUrl = res.finalUrl;
      if (res.stoppedReason === "blocked") {
        finding.flags.push({
          id: "redirect.blocked",
          severity: "high",
          detail: "Redirects toward a private/internal or disallowed destination",
        });
        finding.riskScore = Math.max(finding.riskScore, 75);
      } else if (res.stoppedReason === "max_redirects") {
        finding.flags.push({ id: "redirect.too_many", severity: "medium", detail: "Bounces through many redirects" });
        finding.riskScore = Math.max(finding.riskScore, 45);
      } else if (res.stoppedReason) {
        metrics.urlAnalysisFailure(`redirect_${res.stoppedReason}`);
      }
      if (res.finalUrl !== finding.url) {
        const final = analyzeUrlStatic(res.finalUrl, reputation, { checkedBy });
        if (final.registrableDomain !== finding.registrableDomain) {
          finding.flags.push({
            id: "redirect.cross_domain",
            severity: "low",
            detail: `Actually leads to ${final.hostname}`,
          });
        }
        for (const f of final.flags) finding.flags.push({ ...f, detail: `Destination: ${f.detail}` });
        finding.riskScore = Math.max(finding.riskScore, final.riskScore);
      }
    } catch (error) {
      metrics.urlAnalysisFailure("redirect_exception");
      logger.warn("redirect_resolution_failed", { requestId: opts.requestId, error });
    }
  }
  return findings;
}
