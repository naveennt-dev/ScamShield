import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { getDashboardStats } from "@/lib/services/stats-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi({ route: "v1.stats", auth: "required", rateLimit: "read" }, async ({ requestId, startedAt, user }) => {
  return ok(await getDashboardStats(user!.id), { requestId, startedAt });
});

export const OPTIONS = preflight;
