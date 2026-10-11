import { ApiError } from "@/lib/api/errors";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { deleteAnalysis, getAnalysis } from "@/lib/services/history-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[a-z0-9]{10,40}$/i;

export const GET = withApi<{ id: string }>(
  { route: "v1.history.get", auth: "required", rateLimit: "read" },
  async ({ params, requestId, startedAt, user }) => {
    if (!ID.test(params.id)) throw new ApiError("NOT_FOUND");
    // Scoped by the session user: another user's id yields 404 (no existence oracle).
    const a = await getAnalysis(user!.id, params.id);
    if (!a) throw new ApiError("NOT_FOUND");
    return ok(a, { requestId, startedAt });
  },
);

export const DELETE = withApi<{ id: string }>(
  { route: "v1.history.delete", auth: "required", rateLimit: "write" },
  async ({ params, requestId, startedAt, user }) => {
    if (!ID.test(params.id) || !(await deleteAnalysis(user!.id, params.id))) throw new ApiError("NOT_FOUND");
    return ok({ deleted: true }, { requestId, startedAt });
  },
);

export const OPTIONS = preflight;
