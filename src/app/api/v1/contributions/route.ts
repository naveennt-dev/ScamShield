import { getEnv } from "@/lib/config/env";
import { readJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { ContributionSchema, recordContribution } from "@/lib/services/contribution-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/contributions — opt-in shared-learning contribution (masked text + feedback).
 * Disabled unless CONTRIBUTIONS_ENABLED=true. Stored QUARANTINED; never changes a model.
 */
export const POST = withApi({ route: "v1.contributions.create", auth: "optional", rateLimit: "contribute" }, async ({ req, requestId, startedAt }) => {
  const env = getEnv();
  if (!env.CONTRIBUTIONS_ENABLED) throw new ApiError("FORBIDDEN", "This server does not accept contributions.");
  if (!isDatabaseConfigured()) throw new ApiError("SERVICE_UNAVAILABLE");
  const input = await readJson(req, ContributionSchema, Math.min(env.MAX_BODY_BYTES, 16 * 1024));
  const r = await recordContribution(input);
  return ok({ id: r.id, status: r.status, duplicate: r.duplicate }, { requestId, startedAt }, { status: r.duplicate ? 200 : 201 });
});

export const OPTIONS = preflight;
