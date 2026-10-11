import { getEnv } from "@/lib/config/env";
import { runPipeline, type PipelineDeps } from "@/lib/detection/pipeline";
import type { RuleSignal } from "@/lib/detection/types";
import type { AnalysisResult, ScamCategory } from "@/lib/schemas/analysis";
import type { CoverageItem, DynamicSummary, LinkCategory, LinkEvidence, LinkReport, LinkVerdict } from "@/lib/schemas/link";
import { analyzeUrlStatic, isOfficialBrandHost } from "@/lib/url/analyzer";
import type { Resolver } from "@/lib/url/safety";
import { canonicalizeLink } from "./canonicalize";
import { inspectDownload, isLikelyDownload, type DownloadInspection } from "./download";
import { fetchDocument, type DocTransport, type FetchedDocument } from "./fetch";
import { inspectHtml, type PageInspection } from "./html";
import { lookupUrlIntel, type UrlIntelResult, type UrlThreatProvider } from "./intel";
import { hostOnly, redactUrl } from "./redact";
import { classifyYouTubeLink, isOfficialYouTubeHost } from "./youtube";

/**
 * Link scan: the layered pipeline for one URL.
 *
 *  1 canonicalise (no network) → 2 static URL heuristics + look-alike/punycode checks →
 *  3 ScamShield's own intelligence (local DB) → [network allowed only] 4 SSRF-safe redirect chain +
 *  static page / download inspection → 5 external URL intelligence (configured providers) →
 *  6 [explicit request] isolated dynamic inspection → 7 local rules + installed ML + optional AI
 *  second opinion through the EXISTING detection pipeline/risk engine (page evidence enters as
 *  deterministic signals; the AI can raise but never lower) → 8 evidence-based verdict.
 *
 * "On this device only" (analysisMode local) makes no outbound request at all: steps 4–6 and the
 * AI are skipped and reported as skipped.
 */

export interface LinkScanDeps {
  pipeline?: PipelineDeps;
  transport?: DocTransport;
  resolver?: Resolver;
  urlProviders?: UrlThreatProvider[];
  dynamic?: ((url: string, signal?: AbortSignal) => Promise<DynamicSummary>) | null;
}

export interface LinkScanInput {
  url: string;
  requestId: string;
  networkAllowed: boolean;
  allowAi: boolean;
  inspectBehaviour: boolean;
  signal?: AbortSignal;
}

const SEV_WEIGHT = { low: 0.1, medium: 0.25, high: 0.5 } as const;
const CATEGORY_LABEL: Record<LinkCategory, string> = {
  phishing: "Phishing (fake login / data theft)",
  scam: "Scam content",
  malware: "Malware download",
  redirect: "Suspicious redirects",
  unknown: "Other / unknown threats",
};
const VERDICT_LABEL: Record<LinkVerdict, string> = {
  malicious: "Malicious",
  high_risk: "High risk",
  suspicious: "Suspicious",
  no_known_threat: "No known threat detected",
  inconclusive: "Inconclusive",
};

const STATIC_FLAG_CATEGORY: Record<string, LinkCategory> = {
  "host.brand_impersonation": "phishing",
  "host.typosquat": "phishing",
  "host.homograph": "phishing",
  "host.punycode": "phishing",
  "url.userinfo": "phishing",
  "path.sensitive_keywords": "phishing",
  "host.shortener": "redirect",
  "path.executable": "malware",
  "scheme.dangerous": "malware",
};

function categoryToScam(c: LinkCategory): ScamCategory {
  return c === "phishing" ? "phishing" : c === "malware" ? "malware" : "other";
}

export async function scanLink(input: LinkScanInput, deps: LinkScanDeps = {}): Promise<LinkReport> {
  const env = getEnv();
  const evidence: LinkEvidence[] = [];
  const coverage: CoverageItem[] = [];
  const limitations: string[] = [];
  const disclosures: string[] = [];
  const add = (e: LinkEvidence) => {
    if (!evidence.some((x) => x.id === e.id && x.detail === e.detail)) evidence.push(e);
  };
  const cover = (id: string, label: string, status: CoverageItem["status"], detail: string | null = null) => coverage.push({ id, label, status, detail });

  // 1. Canonicalise
  const c = canonicalizeLink(input.url);
  if (!c.ok) {
    cover("canonical", "Address parsing", "failed", c.detail);
    const dangerous = c.reason === "unsupported_scheme" && /javascript:|data:|vbscript:|file:/i.test(input.url.trim().slice(0, 20));
    if (dangerous) add({ id: "scheme.dangerous", category: "malware", kind: "heuristic", severity: "high", detail: c.detail });
    return finish({ c: null, verdict: dangerous ? "high_risk" : "inconclusive", summary: c.detail });
  }
  cover("canonical", "Address parsing", "done", c.notes.join(" ") || null);
  const shown = redactUrl(c.url).url;
  if (c.defanged) add({ id: "url.defanged", category: "unknown", kind: "heuristic", severity: "medium", detail: "The link was disguised (hxxp / [.]) — a way to slip past filters." });

  // 2. Static URL heuristics + look-alike checks (+ YouTube relationship)
  const yt = classifyYouTubeLink(c.url);
  const staticFinding = analyzeUrlStatic(c.url);
  for (const f of staticFinding.flags) {
    add({ id: f.id, category: STATIC_FLAG_CATEGORY[f.id] ?? "unknown", kind: "heuristic", severity: f.severity, detail: f.detail });
  }
  if (yt.relation === "imitation") add({ id: "youtube.imitation_address", category: "phishing", kind: "heuristic", severity: "high", detail: yt.detail! });
  cover("static", "Address & look-alike checks", "done");

  // 3–5. Network stages
  let doc: FetchedDocument | null = null;
  let page: PageInspection | null = null;
  let download: DownloadInspection | null = null;
  let intel: UrlIntelResult[] = [];
  if (!input.networkAllowed) {
    cover("redirects", "Redirect chain", "skipped", "On this device only: the website was not contacted.");
    cover("page", "Page content (static)", "skipped", "On this device only.");
    cover("download", "Download inspection", "skipped", "On this device only.");
    limitations.push("On-device-only mode: the website was not contacted, so redirects, page content and downloads were not checked.");
  } else {
    doc = await fetchDocument(c.url, {
      maxRedirects: env.URL_FETCH_MAX_REDIRECTS,
      timeoutMs: Math.max(env.URL_FETCH_TIMEOUT_MS, 8000),
      maxBytes: 2 * 1024 * 1024,
      transport: deps.transport,
      resolver: deps.resolver,
      signal: input.signal,
    });
    disclosures.push(`The website (${c.displayHostname}${doc.chain.length > 1 ? " and the sites it redirected to" : ""}) was contacted from this device by ScamShield's inspector — without your cookies or accounts.`);
    redirectEvidence(doc, c.registrableDomain, add);
    if (doc.failure) {
      const detail = `${doc.failureDetail ?? doc.failure}`;
      cover("redirects", "Redirect chain", doc.chain.length > 1 ? "done" : "failed", doc.chain.length > 1 ? `${doc.chain.length - 1} redirect(s), then: ${detail}` : detail);
      cover("page", "Page content (static)", "failed", detail);
      if (doc.failure === "tls") add({ id: "net.tls_error", category: "unknown", kind: "heuristic", severity: "medium", detail: `The website's secure connection is broken (${detail}).` });
      if (doc.failure === "blocked") add({ id: "redirect.to_internal", category: "redirect", kind: "heuristic", severity: "high", detail: "The link leads toward a private/internal or disallowed network address — never legitimate in a message." });
      if (doc.failure === "too_many_redirects") add({ id: "redirect.too_many", category: "redirect", kind: "heuristic", severity: "medium", detail: "The link bounces through too many redirects." });
      if (doc.failure !== "blocked") limitations.push(`The website couldn't be inspected: ${detail}.`);
    } else {
      cover("redirects", "Redirect chain", "done", doc.chain.length > 1 ? `${doc.chain.length - 1} redirect(s)` : "no redirects");
      if (doc.body && isLikelyDownload(doc.contentType, doc.contentDisposition, doc.finalUrl)) {
        download = inspectDownload(doc.body, !doc.truncated, { url: doc.finalUrl, contentType: doc.contentType, contentDisposition: doc.contentDisposition, contentLength: doc.contentLength });
        downloadEvidence(download, add);
        cover("page", "Page content (static)", "not_applicable", "The link starts a file download.");
        cover("download", "Download inspection (static)", "done", `${download.detectedKind.replace(/_/g, " ")}, ${download.bytesInspected} bytes inspected${download.sha256 ? "" : " (partial — no full hash)"}`);
        limitations.push("Downloads are identified and hashed only — they are never opened or run, so this is not a malware scan of the file.");
      } else if (doc.body) {
        page = inspectHtml(doc.body, doc.finalUrl);
        pageEvidence(page, doc.finalUrl, add);
        cover("page", "Page content (static)", "done", doc.truncated ? "first 2 MB inspected" : null);
        cover("download", "Download inspection", "not_applicable", page.downloadLinks.length ? `${page.downloadLinks.length} download link(s) listed on the page` : null);
        limitations.push("Static page inspection reads the page's code without running it; scripts can change the page later (use “Inspect page behaviour”).");
      }
    }
  }

  // ScamShield's own intelligence DB is local; external providers only with network allowed.
  intel = await lookupUrlIntel(doc?.finalUrl ?? c.url, { networkAllowed: input.networkAllowed, providers: deps.urlProviders, signal: input.signal });
  if (doc && doc.finalUrl !== c.url) {
    const first = await lookupUrlIntel(c.url, { networkAllowed: input.networkAllowed, providers: deps.urlProviders, signal: input.signal });
    intel = intel.map((r, i) => (first[i]?.status === "listed" ? first[i] : r));
  }
  for (const r of intel) {
    cover(`intel.${r.provider}`, r.provider, r.status === "listed" || r.status === "not_listed" ? "done" : r.status === "not_configured" ? "unavailable" : r.status === "skipped" ? "skipped" : "failed", r.detail);
    if (r.sent) disclosures.push(`${r.provider} received: ${r.sent}`);
    if (r.status === "listed") add({ id: `intel.${r.provider}`, category: r.threat === "phishing" ? "phishing" : "malware", kind: "confirmed_intel", severity: "high", detail: r.detail ?? `Listed by ${r.provider}` });
  }
  if (intel.every((r) => r.status === "not_configured")) limitations.push("No external threat-intelligence service is configured — the link was not checked against public threat lists.");

  // 6. Optional isolated dynamic inspection (explicit request only)
  let dynamic: DynamicSummary | null = null;
  if (input.inspectBehaviour) {
    if (!input.networkAllowed) {
      cover("dynamic", "Page behaviour (isolated browser)", "skipped", "On this device only: the website is never loaded.");
    } else if (!deps.dynamic || !env.DYNAMIC_INSPECTION_ENABLED) {
      cover("dynamic", "Page behaviour (isolated browser)", "unavailable", "Dynamic inspection is turned off on this ScamShield service.");
    } else if (download) {
      cover("dynamic", "Page behaviour (isolated browser)", "not_applicable", "The link is a file download.");
    } else {
      dynamic = await deps.dynamic(c.url, input.signal);
      dynamicEvidence(dynamic, add);
      cover("dynamic", "Page behaviour (isolated browser)", dynamic.status === "completed" ? "done" : dynamic.status === "unavailable" ? "unavailable" : "failed", dynamic.detail);
      if (dynamic.status !== "unavailable") {
        limitations.push(`Page behaviour was observed for ${Math.round(dynamic.observedWindowMs / 1000)} s in an isolated browser with synthetic data only; behaviour after that window, after real logins or on other devices was not observed.`);
      }
    }
  } else {
    cover("dynamic", "Page behaviour (isolated browser)", "skipped", "Not requested (use “Inspect page behaviour”).");
  }

  // 7. Local rules + installed ML + optional AI second opinion, fused by the existing risk engine.
  const signals: RuleSignal[] = evidence
    .filter((e) => !staticFinding.flags.some((f) => f.id === e.id)) // static URL flags already enter via the URL analyser
    .map((e) => ({
      ruleId: `link.${e.id}`,
      category: categoryToScam(e.category),
      severity: e.severity,
      evidence: e.detail.slice(0, 280),
      weight: e.kind === "confirmed_intel" ? 0.9 : e.kind === "observed_behaviour" && e.severity === "high" ? 0.8 : SEV_WEIGHT[e.severity],
      description: e.detail,
    }));
  const pageText = page ? [page.title ?? "", page.textSample].join("\n").trim() : "";
  const hostLine = hostOnly(c.url);
  let analysis: AnalysisResult | null = null;
  try {
    const out = await runPipeline(
      {
        inputType: "url",
        text: `${shown}${pageText ? `\n${pageText}` : ""}`,
        remoteText: `Website: ${hostLine}${doc && doc.finalUrl !== c.url ? `\nFinal destination: ${hostOnly(doc.finalUrl)}` : ""}`,
        requestId: input.requestId,
        allowLlm: input.allowAi && input.networkAllowed,
        remoteRequested: input.allowAi,
        extraUrls: [c.url, ...(doc && doc.finalUrl !== c.url ? [doc.finalUrl] : [])],
        extraSignals: signals,
        followRedirects: false,
      },
      deps.pipeline ?? {},
    );
    analysis = out.result;
    // Stored/displayed forms of the analysed URLs never carry query values.
    analysis.urls = analysis.urls.map((u) => ({ ...u, url: redactUrl(u.url).url, finalUrl: u.finalUrl ? redactUrl(u.finalUrl).url : u.finalUrl }));
    const ml = analysis.signals.find((s) => s.source === "ml");
    cover("ml", "Local ML model", ml?.available ? "done" : "unavailable", ml?.note ?? null);
    const ra = analysis.remoteAnalysis;
    cover("ai", "AI second opinion", ra.used ? "done" : !input.allowAi ? "skipped" : !input.networkAllowed ? "skipped" : "failed", ra.used ? "Used as a second opinion only — it can raise but never lower the result." : ra.reason ?? ra.status);
    if (ra.used) {
      disclosures.push(`The AI second opinion received the website address (${hostLine}${doc && doc.finalUrl !== c.url ? ` → ${hostOnly(doc.finalUrl)}` : ""}) and the list of findings — no page content, no full link.`);
      const llm = analysis.signals.find((s) => s.source === "llm");
      if (llm?.score != null && llm.score >= 60) add({ id: "ai.opinion", category: "unknown", kind: "ai_opinion", severity: "medium", detail: `AI second opinion rated it ${Math.round(llm.score)}/100 (interpretation, not evidence).` });
    }
  } catch {
    cover("ml", "Local ML model", "failed", "analysis failed");
    limitations.push("The local detection engine failed for this link.");
  }

  // 8. Verdict
  // "Malicious" needs confirmation: a threat-list listing, or observed theft of typed data. Strong
  // but inferential evidence (disguised files, look-alikes) stays "high risk".
  const confirmed = evidence.some((e) => e.kind === "confirmed_intel" || e.id === "dynamic.typed_data_exfiltration");
  const failedChecks = coverage.filter((x) => x.status === "failed");
  let verdict: LinkVerdict;
  if (confirmed) verdict = "malicious";
  else if (!analysis) verdict = "inconclusive";
  else if (analysis.riskLevel === "high" || analysis.riskLevel === "critical") verdict = "high_risk";
  else if (analysis.riskLevel === "suspicious") verdict = "suspicious";
  else if (analysis.assessment.status === "insufficient" || failedChecks.some((x) => ["page", "dynamic", "redirects"].includes(x.id) && !/does not resolve|refused/.test(x.detail ?? ""))) verdict = "inconclusive";
  else verdict = "no_known_threat";

  return finish({ c, verdict, analysis, doc, page, download, dynamic, yt, shown });

  function finish(o: {
    c: typeof c | null;
    verdict: LinkVerdict;
    summary?: string;
    analysis?: AnalysisResult | null;
    doc?: FetchedDocument | null;
    page?: PageInspection | null;
    download?: DownloadInspection | null;
    dynamic?: DynamicSummary | null;
    yt?: ReturnType<typeof classifyYouTubeLink>;
    shown?: string;
  }): LinkReport {
    const ok = Boolean(o.c && o.c.ok);
    const cc = o.c && o.c.ok ? o.c : null;
    const pageKind: LinkReport["page"]["kind"] =
      o.yt?.relation === "official" ? "official_youtube"
      : o.yt?.relation === "official_redirect" ? "youtube_redirect"
      : evidence.some((e) => e.id.startsWith("youtube.imitation")) ? "youtube_imitation"
      : o.download ? "download"
      : o.page?.frames.some((f) => f.youtubeEmbed) ? "third_party_with_youtube_embed"
      : o.page ? "third_party" : "not_inspected";
    const embeds = o.page?.frames.filter((f) => f.youtubeEmbed).length ?? 0;
    const ytNote =
      pageKind === "official_youtube" ? "This is YouTube's own website. Video content itself is not checked."
      : pageKind === "youtube_redirect" ? "YouTube's “leaving YouTube” redirect — the destination was analysed as a separate website."
      : pageKind === "third_party_with_youtube_embed" ? "The video player comes from YouTube, but the page around it is a different website and was analysed separately — the embedded video does not make the page safe."
      : pageKind === "youtube_imitation" ? "Uses YouTube's name or look but is not a YouTube website."
      : null;
    const categories = (Object.keys(CATEGORY_LABEL) as LinkCategory[]).map((cat) => {
      const ev = evidence.filter((e) => e.category === cat && e.severity !== "low").map((e) => e.detail);
      const inspected = Boolean(o.page || o.download || o.dynamic);
      const checked = cat === "phishing" || cat === "unknown" ? ok : cat === "redirect" ? Boolean(o.doc) : cat === "malware" ? inspected || ok : inspected;
      return { category: cat, label: CATEGORY_LABEL[cat], status: (ev.length ? "indicators_found" : checked ? "none_found" : "not_checked") as "indicators_found" | "none_found" | "not_checked", evidence: ev.slice(0, 6) };
    });
    if (o.verdict === "no_known_threat") limitations.push("“No known threat detected” means the checks that ran found nothing — it is not a guarantee that the link is safe.");
    const strongCred = evidence.some((e) => e.category === "phishing" && e.severity !== "low");
    const dl = evidence.some((e) => e.category === "malware" && e.severity !== "low");
    const action =
      o.verdict === "malicious" || o.verdict === "high_risk"
        ? `Don't open it. If it's already open, leave the page${strongCred ? " and don't enter any password, OTP or card details" : ""}${dl ? " and don't download or run anything from it" : ""}.`
        : o.verdict === "suspicious"
          ? `Be careful: ${strongCred ? "don't enter passwords, OTPs or card details; go to the official website yourself instead" : dl ? "don't download or run files from it" : "verify the sender and go to the official website yourself instead"}.`
          : o.verdict === "inconclusive"
            ? "This link couldn't be checked fully. Don't enter passwords or download anything from it unless you're sure of the sender."
            : "No known threat was found by the checks that ran. Continue cautiously — still don't enter passwords or card details unless you typed the address yourself.";
    const top = evidence.filter((e) => e.severity === "high").slice(0, 2).map((e) => e.detail);
    const summary =
      o.summary ??
      (o.verdict === "malicious" ? `Confirmed: ${top[0] ?? "listed as malicious"}`
        : o.verdict === "high_risk" ? `Several strong warning signs: ${top.join("; ") || "see the evidence"}`
          : o.verdict === "suspicious" ? "Some warning signs, but not conclusive."
            : o.verdict === "inconclusive" ? "Not enough reliable evidence — some checks could not run."
              : "The checks that ran found no current threat indicators.");
    return {
      input: redactUrl(input.url.trim()).url.slice(0, 500),
      ok,
      url: o.shown ?? null,
      hostname: cc?.hostname ?? null,
      displayHostname: cc?.displayHostname ?? null,
      registrableDomain: cc?.registrableDomain ?? null,
      canonicalNotes: cc?.notes ?? [],
      redirectChain: (o.doc?.chain ?? []).map((h) => ({ url: redactUrl(h.url).url, status: h.status })),
      finalUrl: o.doc ? redactUrl(o.doc.finalUrl).url : null,
      page: { kind: pageKind, title: o.page?.title ?? null, youtube: { videoId: o.yt?.videoId ?? null, embeddedPlayers: embeds, note: ytNote } },
      download: o.download
        ? { fileName: o.download.fileName, detectedKind: o.download.detectedKind, declaredMime: o.download.declaredMime, sha256: o.download.sha256, bytesInspected: o.download.bytesInspected, mismatch: o.download.mismatch }
        : null,
      verdict: o.verdict,
      verdictLabel: VERDICT_LABEL[o.verdict],
      summary,
      recommendedAction: action,
      categories,
      evidence: evidence.sort((a, b) => kindRank(a) - kindRank(b) || sevRank(b) - sevRank(a)),
      coverage,
      limitations: [...new Set(limitations)],
      disclosures,
      dynamic: o.dynamic ?? null,
      analysis: o.analysis ?? null,
    };
  }
}

/** Page-controlled text quoted in findings: printable characters only, one line, bounded. */
export function cleanQuoted(s: string, max = 60): string {
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029<>"“”`]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const kindRank = (e: LinkEvidence) => ({ confirmed_intel: 0, observed_behaviour: 1, heuristic: 2, ai_opinion: 3 })[e.kind];
const sevRank = (e: LinkEvidence) => ({ low: 0, medium: 1, high: 2 })[e.severity];

function redirectEvidence(doc: FetchedDocument, startSite: string | null, add: (e: LinkEvidence) => void) {
  const hops = doc.chain.map((h) => h.url);
  if (hops.length <= 1) return;
  const finalStatic = analyzeUrlStatic(doc.finalUrl);
  if (finalStatic.registrableDomain && finalStatic.registrableDomain !== startSite) {
    add({ id: "redirect.cross_site", category: "redirect", kind: "observed_behaviour", severity: "low", detail: `The link actually leads to ${finalStatic.hostname}.` });
  }
  if (hops.length >= 4) add({ id: "redirect.long_chain", category: "redirect", kind: "observed_behaviour", severity: "medium", detail: `Bounces through ${hops.length - 1} redirects before the final page.` });
  for (const h of hops.slice(1)) {
    const s = analyzeUrlStatic(h);
    for (const f of s.flags) {
      if (f.severity === "low") continue;
      add({ id: `redirect.${f.id}`, category: STATIC_FLAG_CATEGORY[f.id] ?? "redirect", kind: "heuristic", severity: f.severity, detail: `Redirect destination ${s.hostname}: ${f.detail}` });
    }
  }
}

function pageEvidence(p: PageInspection, pageUrl: string, add: (e: LinkEvidence) => void) {
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    /* keep empty */
  }
  const official = host ? isOfficialBrandHost(host) || isOfficialYouTubeHost(host) : false;
  const brandFlags = analyzeUrlStatic(pageUrl).flags.some((f) => ["host.brand_impersonation", "host.typosquat", "host.homograph"].includes(f.id));
  for (const f of p.forms) {
    if (official) break;
    const what = [f.password && "password", f.card && "card details", f.otp && "OTP/PIN"].filter(Boolean).join(", ");
    if (!what) continue;
    if (f.crossSite) add({ id: "page.credential_form_cross_site", category: "phishing", kind: "heuristic", severity: "high", detail: `A form asks for ${what} and sends it to a different website (${f.actionHost}).` });
    else if (brandFlags || f.card || f.otp) add({ id: "page.credential_form_lookalike", category: "phishing", kind: "heuristic", severity: f.card || f.otp ? "high" : "medium", detail: `The page asks for ${what}${brandFlags ? " on a look-alike website" : ""}.` });
    else add({ id: "page.password_form", category: "phishing", kind: "heuristic", severity: "low", detail: `The page has a ${what} field (normal for login pages — check the address is the real site).` });
  }
  const embeds = p.frames.filter((f) => f.youtubeEmbed);
  const risky = p.fakePrompts.length > 0 || p.downloadLinks.length > 0 || p.forms.some((f) => f.password || f.card || f.otp) || p.frames.some((f) => f.hidden && f.crossSite) || p.obfuscatedScript;
  if (!official && embeds.length > 0 && risky) {
    add({ id: "youtube.suspicious_wrapper", category: "scam", kind: "heuristic", severity: "high", detail: "A real YouTube video is embedded in a page that also shows warning signs (prompts, downloads, login forms or hidden frames) — a typical wrapper used to look trustworthy." });
  }
  if (!official && embeds.length === 0 && p.mentionsYouTube && /youtube/i.test(p.title ?? "")) {
    add({ id: "youtube.imitation_page", category: "phishing", kind: "heuristic", severity: "high", detail: `Presents itself as YouTube (“${cleanQuoted(p.title ?? "")}”) but is not a YouTube website and does not use YouTube's player.` });
  }
  for (const label of p.fakePrompts) {
    const malware = /update|download|infected/.test(label);
    add({ id: `page.prompt.${label.replace(/\W+/g, "_").slice(0, 30)}`, category: malware ? "malware" : "scam", kind: "heuristic", severity: malware ? "high" : "medium", detail: `The page ${label}.` });
  }
  for (const f of p.frames.filter((x) => x.hidden && x.crossSite).slice(0, 3)) {
    add({ id: "page.hidden_frame", category: "unknown", kind: "heuristic", severity: "medium", detail: `A hidden frame loads another website (${f.host}).` });
  }
  for (const r of [p.metaRefresh, ...p.scriptRedirects].filter((x): x is string => Boolean(x))) {
    const s = analyzeUrlStatic(r);
    let cross = false;
    try {
      cross = new URL(r).hostname !== host;
    } catch {
      /* ignore */
    }
    if (!cross) continue;
    const bad = s.flags.filter((f) => f.severity !== "low");
    add({ id: "page.auto_redirect", category: "redirect", kind: "heuristic", severity: bad.length ? "high" : "medium", detail: `The page sends visitors on to ${s.hostname || r.slice(0, 80)}${bad.length ? ` (${bad[0].detail})` : ""}.` });
  }
  const exes = p.downloadLinks.filter((d) => /\.(apk|exe|msi|scr|bat|cmd|ps1|vbs|jar|dmg|pkg|xapk|apks)(\?|$)/i.test(d));
  if (exes.length) add({ id: "page.executable_links", category: "malware", kind: "heuristic", severity: "medium", detail: `The page offers program/app files to download (${exes.length}).` });
  if (p.obfuscatedScript) add({ id: "page.obfuscated_script", category: "unknown", kind: "heuristic", severity: "medium", detail: "The page contains deliberately obfuscated script code (its behaviour can't be read statically)." });
  for (const h of p.exfilHints) add({ id: `page.script_capability.${h.replace(/\W+/g, "_").slice(0, 30)}`, category: "unknown", kind: "heuristic", severity: "low", detail: `A script on the page ${h} — a capability, not proof of data theft.` });
  if (p.permissionApis.length && !official) {
    add({ id: "page.permission_requests", category: p.fakePrompts.length ? "scam" : "unknown", kind: "heuristic", severity: p.fakePrompts.length ? "medium" : "low", detail: `Scripts may ask for: ${p.permissionApis.join(", ")}.` });
  }
}

function downloadEvidence(d: DownloadInspection, add: (e: LinkEvidence) => void) {
  if (d.mismatch) add({ id: "download.type_mismatch", category: "malware", kind: "observed_behaviour", severity: "high", detail: `The downloaded file is disguised: ${d.mismatch}.` });
  const name = d.fileName ? cleanQuoted(d.fileName, 80) : null;
  if (d.doubleExtension) add({ id: "download.double_extension", category: "malware", kind: "heuristic", severity: "high", detail: `The file name hides its real type (${name}).` });
  if (d.executable && !d.mismatch) add({ id: "download.executable", category: "malware", kind: "heuristic", severity: "medium", detail: `The link downloads a program/app (${d.detectedKind.replace(/_/g, " ")}${name ? `: ${name}` : ""}). Install software only from official stores/websites.` });
  if (d.macroCapable) add({ id: "download.macro_document", category: "malware", kind: "heuristic", severity: "medium", detail: "The file is an Office document type that can contain macros." });
}

function dynamicEvidence(d: DynamicSummary, add: (e: LinkEvidence) => void) {
  if (d.typedDataSentTo.length) add({ id: "dynamic.typed_data_exfiltration", category: "phishing", kind: "observed_behaviour", severity: "high", detail: `Observed: a test e-mail/password typed into the page (synthetic, never submitted) was sent to another website: ${d.typedDataSentTo.join(", ")}.` });
  if ((d.passwordSentToSameSite ?? []).length) add({ id: "dynamic.password_sent_while_typing", category: "phishing", kind: "observed_behaviour", severity: "medium", detail: "Observed: a test password was sent to the page's own server while it was being typed, before any submit." });
  if (d.downloadsAttempted.length) add({ id: "dynamic.auto_download", category: "malware", kind: "observed_behaviour", severity: "high", detail: `Observed: the page tried to start a download by itself (${d.downloadsAttempted.slice(0, 2).map((n) => cleanQuoted(n, 80)).join(", ")}) — blocked.` });
  if (d.permissionRequests.length) add({ id: "dynamic.permission_requests", category: "scam", kind: "observed_behaviour", severity: "medium", detail: `Observed: the page asked for ${d.permissionRequests.join(", ")} — denied.` });
  // Only genuine internal-network attempts count — not names that simply don't resolve.
  const internal = d.requests.blocked.filter((b) => /private|internal|single_label|non_public_suffix|loopback|link_local|reserved/.test(b.reason));
  if (internal.length) add({ id: "dynamic.internal_access", category: "unknown", kind: "observed_behaviour", severity: "high", detail: `Observed: the page tried to reach private/internal network addresses (${internal.slice(0, 2).map((b) => b.target).join(", ")}) — blocked.` });
  if (d.postsToThirdParties.length) add({ id: "dynamic.third_party_posts", category: "unknown", kind: "observed_behaviour", severity: "low", detail: `Observed: the page sent data to other websites (${d.postsToThirdParties.slice(0, 3).join(", ")}).` });
  if (d.popups.length) add({ id: "dynamic.popups", category: "scam", kind: "observed_behaviour", severity: "low", detail: `Observed: the page opened pop-ups (${d.popups.length}).` });
  if (d.passwordFieldsAfterScripts > 0 && d.domChangedByScripts) add({ id: "dynamic.injected_login", category: "phishing", kind: "observed_behaviour", severity: "medium", detail: "Observed: scripts added a password field after the page loaded." });
}
