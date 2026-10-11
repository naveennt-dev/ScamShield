import { z } from "zod";
import { AnalysisResultSchema, SeveritySchema } from "./analysis";

/** Link scan report (POST /api/v1/analyze/link). See src/lib/linkscan/scan.ts. */

export const LinkVerdictSchema = z.enum(["malicious", "high_risk", "suspicious", "no_known_threat", "inconclusive"]);
export type LinkVerdict = z.infer<typeof LinkVerdictSchema>;

export const LinkCategorySchema = z.enum(["phishing", "scam", "malware", "redirect", "unknown"]);
export type LinkCategory = z.infer<typeof LinkCategorySchema>;

/** Where a piece of evidence comes from — confirmed intelligence vs observed vs heuristic vs AI. */
export const EvidenceKindSchema = z.enum(["confirmed_intel", "observed_behaviour", "heuristic", "ai_opinion"]);

export const LinkEvidenceSchema = z.object({
  id: z.string(),
  category: LinkCategorySchema,
  kind: EvidenceKindSchema,
  severity: SeveritySchema,
  detail: z.string(),
});
export type LinkEvidence = z.infer<typeof LinkEvidenceSchema>;

export const CheckStatusSchema = z.enum(["done", "skipped", "failed", "unavailable", "not_applicable"]);
export const CoverageItemSchema = z.object({ id: z.string(), label: z.string(), status: CheckStatusSchema, detail: z.string().nullable() });
export type CoverageItem = z.infer<typeof CoverageItemSchema>;

export const CategoryResultSchema = z.object({
  category: LinkCategorySchema,
  label: z.string(),
  status: z.enum(["indicators_found", "none_found", "not_checked"]),
  evidence: z.array(z.string()),
});

export const PageKindSchema = z.enum([
  "official_youtube",
  "youtube_redirect",
  "youtube_imitation",
  "third_party_with_youtube_embed",
  "third_party",
  "download",
  "not_inspected",
]);

export const DynamicSummarySchema = z.object({
  status: z.enum(["completed", "partial", "failed", "unavailable", "cancelled", "timeout"]),
  detail: z.string().nullable(),
  durationMs: z.number(),
  observedWindowMs: z.number(),
  finalUrl: z.string().nullable(),
  navigations: z.array(z.string()),
  requests: z.object({ total: z.number(), thirdPartyHosts: z.array(z.string()), blocked: z.array(z.object({ target: z.string(), reason: z.string() })) }),
  downloadsAttempted: z.array(z.string()),
  permissionRequests: z.array(z.string()),
  dialogs: z.array(z.string()),
  popups: z.array(z.string()),
  framesAfterScripts: z.array(z.string()),
  formsAfterScripts: z.number(),
  passwordFieldsAfterScripts: z.number(),
  /** Synthetic text typed into fields was seen leaving the page (before any submit). */
  typedDataSentTo: z.array(z.string()),
  /** A synthetic password was sent to the page's own site as it was typed (before any submit). */
  passwordSentToSameSite: z.array(z.string()).default([]),
  postsToThirdParties: z.array(z.string()),
  domChangedByScripts: z.boolean(),
});
export type DynamicSummary = z.infer<typeof DynamicSummarySchema>;

export const LinkReportSchema = z.object({
  input: z.string(),
  ok: z.boolean(),
  /** Canonical URL with sensitive parameters masked (the only form stored or displayed). */
  url: z.string().nullable(),
  hostname: z.string().nullable(),
  displayHostname: z.string().nullable(),
  registrableDomain: z.string().nullable(),
  canonicalNotes: z.array(z.string()),
  redirectChain: z.array(z.object({ url: z.string(), status: z.number().nullable() })),
  finalUrl: z.string().nullable(),
  page: z.object({
    kind: PageKindSchema,
    title: z.string().nullable(),
    youtube: z.object({ videoId: z.string().nullable(), embeddedPlayers: z.number(), note: z.string().nullable() }),
  }),
  download: z
    .object({
      fileName: z.string().nullable(),
      detectedKind: z.string(),
      declaredMime: z.string().nullable(),
      sha256: z.string().nullable(),
      bytesInspected: z.number(),
      mismatch: z.string().nullable(),
    })
    .nullable(),
  verdict: LinkVerdictSchema,
  verdictLabel: z.string(),
  summary: z.string(),
  recommendedAction: z.string(),
  categories: z.array(CategoryResultSchema),
  evidence: z.array(LinkEvidenceSchema),
  coverage: z.array(CoverageItemSchema),
  limitations: z.array(z.string()),
  /** Every outside party that received anything during this scan. */
  disclosures: z.array(z.string()),
  dynamic: DynamicSummarySchema.nullable(),
  analysis: AnalysisResultSchema.nullable(),
});
export type LinkReport = z.infer<typeof LinkReportSchema>;

export const AnalyzeLinkSchema = z
  .object({
    url: z.string().trim().min(1).max(4096),
    /** "local" = on this device only: no request leaves the device (static checks only). */
    analysisMode: z.enum(["local", "remote-assisted"]).default("local"),
    /** Explicit, per-scan request for the isolated-browser inspection (second stage). */
    inspectBehaviour: z.boolean().default(false),
  })
  .strict();
