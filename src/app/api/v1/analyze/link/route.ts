import { getEnv } from "@/lib/config/env";
import { readJson } from "@/lib/api/body";
import { preflight, withApi } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/errors";
import { hashedClientKey, isLoopbackClient } from "@/lib/api/request-context";
import { ok } from "@/lib/api/response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { AnalyzeLinkSchema } from "@/lib/schemas/link";
import { getSettings } from "@/lib/services/settings-service";
import { scanLink } from "@/lib/linkscan/scan";
import { runDynamicInspection } from "@/lib/linkscan/dynamic/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * POST /api/v1/analyze/link — layered link scan (see src/lib/linkscan/scan.ts).
 * analysisMode "local": nothing leaves the device (static checks only). "remote-assisted": the
 * website itself, configured threat-intel services and the AI second opinion may be contacted.
 * inspectBehaviour: explicit, per-scan request for the isolated-browser stage.
 */
export const POST = withApi(
  { route: "v1.analyze.link", auth: "optional", rateLimit: "analyze_url", anonymousAnalysis: true },
  async ({ req, requestId, startedAt, user }) => {
    const body = await readJson(req, AnalyzeLinkSchema, getEnv().MAX_BODY_BYTES);
    if (body.inspectBehaviour) {
      // Second, much tighter limit for the isolated-browser stage.
      const tier = user ? user.tier : getEnv().LOCAL_CLIENT_RATE_TIER && isLoopbackClient(req) ? "local" : "anonymous";
      const rl = await checkRateLimit("inspect", tier, user ? `u:${user.id}` : `ip:${hashedClientKey(req)}`);
      if (!rl.allowed) throw new ApiError("RATE_LIMITED", "Too many page inspections — please wait a minute.", { headers: rateLimitHeaders(rl) });
    }
    const settings = await getSettings(user?.id ?? null);
    const online = body.analysisMode === "remote-assisted";
    const report = await scanLink(
      { url: body.url, requestId, networkAllowed: online, allowAi: online && settings.allowLlmAnalysis, inspectBehaviour: body.inspectBehaviour, signal: req.signal },
      { dynamic: runDynamicInspection },
    );
    return ok(report, { requestId, startedAt });
  },
);

export const OPTIONS = preflight;
