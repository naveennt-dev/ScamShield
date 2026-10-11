import { getEnv } from "@/lib/config/env";
import { readJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { AnalyzeUrlSchema } from "@/lib/schemas/api";
import { analyzeAndStore } from "@/lib/services/analysis-service";
import { normalizeUrl } from "@/lib/url/extractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(
  { route: "v1.analyze.url", auth: "optional", rateLimit: "analyze_url", anonymousAnalysis: true },
  async ({ req, requestId, startedAt, user }) => {
    const env = getEnv();
    const body = await readJson(req, AnalyzeUrlSchema, env.MAX_BODY_BYTES);
    const raw = body.url.trim();

    // http(s) URLs are normalised; other schemes (javascript:, data:, file:) are analysed as-is so
    // they can be flagged as dangerous. Nothing is fetched unless redirects are explicitly enabled.
    let target = normalizeUrl(raw);
    if (!target) {
      try {
        target = new URL(raw).toString();
      } catch {
        throw new ApiError("VALIDATION_ERROR", undefined, { details: [{ path: "url", message: "must be a valid URL" }] });
      }
    }

    const result = await analyzeAndStore({
      inputType: "url",
      text: target,
      extraUrls: [target],
      followRedirects: body.followRedirects,
      requestId,
      userId: user?.id ?? null,
    });
    if (body.followRedirects && !env.URL_FETCH_ENABLED) {
      result.warnings.push("Redirect checking is disabled on this server; only the link itself was analysed.");
    }
    return ok(result, { requestId, startedAt });
  },
);

export const OPTIONS = preflight;
