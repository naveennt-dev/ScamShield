import { ApiError } from "@/lib/api/errors";
import { zodIssues } from "@/lib/api/body";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { HistoryQuerySchema } from "@/lib/schemas/api";
import { deleteAllHistory, listHistory } from "@/lib/services/history-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi({ route: "v1.history.list", auth: "required", rateLimit: "read" }, async ({ req, requestId, startedAt, user }) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const q = HistoryQuerySchema.safeParse(params);
  if (!q.success) throw new ApiError("VALIDATION_ERROR", undefined, { details: zodIssues(q.error) });
  const page = await listHistory(user!.id, q.data);
  return ok(page, { requestId, startedAt });
});

/** Deletes ALL of the caller's stored analyses (privacy control). */
export const DELETE = withApi({ route: "v1.history.delete_all", auth: "required", rateLimit: "write" }, async ({ requestId, startedAt, user }) => {
  const deleted = await deleteAllHistory(user!.id);
  return ok({ deleted }, { requestId, startedAt });
});

export const OPTIONS = preflight;
