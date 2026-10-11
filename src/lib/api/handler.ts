import { NextResponse } from "next/server";
import { getEnv } from "@/lib/config/env";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { logger, type Logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import { reportError } from "@/lib/observability/error-reporting";
import { checkRateLimit, rateLimitHeaders, type RateLimitScope } from "@/lib/rate-limit";
import { recordEvent } from "@/lib/services/events";
import { ApiError } from "./errors";
import { corsHeaders, isCrossSiteWriteBlocked } from "./origin";
import { hashedClientKey, isLoopbackClient, requestIdFrom } from "./request-context";
import { fail } from "./response";

export interface ApiContext<P = Record<string, string>> {
  req: Request;
  requestId: string;
  startedAt: number;
  user: SessionUser | null;
  params: P;
  log: Logger;
}

export interface ApiOptions {
  /** Metric/log label, e.g. "v1.analyze.message". */
  route: string;
  /** "required": 401 without a session. "optional": user may be null. */
  auth: "required" | "optional";
  rateLimit?: RateLimitScope;
  /** For analysis scopes: honour ALLOW_ANONYMOUS_ANALYSIS. */
  anonymousAnalysis?: boolean;
}

/**
 * Route-handler wrapper: request ID, origin/CSRF check, session, rate limiting, consistent error
 * envelope, structured logging and metrics. Handlers only contain business logic.
 */
export function withApi<P = Record<string, string>>(
  opts: ApiOptions,
  handler: (ctx: ApiContext<P>) => Promise<NextResponse>,
) {
  return async (req: Request, routeCtx?: { params?: Promise<P> }): Promise<NextResponse> => {
    const requestId = requestIdFrom(req);
    const startedAt = Date.now();
    const log = logger.child({ requestId, route: opts.route });
    let status = 500;
    let userId: string | null = null;
    const cors = corsHeaders(req);

    const finish = (res: NextResponse) => {
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      status = res.status;
      return res;
    };

    try {
      if (isCrossSiteWriteBlocked(req)) throw new ApiError("ORIGIN_NOT_ALLOWED");

      const user = await getSessionUser(req.headers);
      userId = user?.id ?? null;
      if (opts.auth === "required" && !user) throw new ApiError("UNAUTHORIZED");
      if (opts.anonymousAnalysis && !user && !getEnv().ALLOW_ANONYMOUS_ANALYSIS) throw new ApiError("UNAUTHORIZED");

      let rlHeaders: Record<string, string> = {};
      if (opts.rateLimit) {
        const tier = user ? user.tier : getEnv().LOCAL_CLIENT_RATE_TIER && isLoopbackClient(req) ? "local" : "anonymous";
        const identity = user ? `u:${user.id}` : `ip:${hashedClientKey(req)}`;
        const rl = await checkRateLimit(opts.rateLimit, tier, identity);
        rlHeaders = rateLimitHeaders(rl);
        if (!rl.allowed) {
          recordEvent({ eventType: "RATE_LIMITED", requestId, userId, metadata: { scope: opts.rateLimit, tier } });
          throw new ApiError("RATE_LIMITED", undefined, { headers: rlHeaders });
        }
      }

      const params = ((await routeCtx?.params) ?? {}) as P;
      const res = await handler({ req, requestId, startedAt, user, params, log });
      for (const [k, v] of Object.entries(rlHeaders)) res.headers.set(k, v);
      return finish(res);
    } catch (err) {
      if (err instanceof ApiError) {
        metrics.error(err.code);
        if (err.status >= 500) log.error("api_error", { code: err.code, userId });
        return finish(fail(err.code, requestId, { message: err.message, details: err.details, headers: err.headers }));
      }
      metrics.error("INTERNAL_ERROR");
      reportError(err, { requestId, route: opts.route, userId });
      recordEvent({ eventType: "REQUEST_FAILED", requestId, userId, errorCode: "INTERNAL_ERROR", metadata: { route: opts.route } });
      return finish(fail("INTERNAL_ERROR", requestId));
    } finally {
      const ms = Date.now() - startedAt;
      metrics.request(opts.route, status);
      metrics.requestLatency(opts.route, ms);
      log.info("http_request", { method: req.method, status, latencyMs: ms, userId });
    }
  };
}

/** CORS preflight handler for API routes. */
export function preflight(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}
