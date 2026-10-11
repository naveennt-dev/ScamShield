import { getEnv } from "@/lib/config/env";
import { readJson } from "@/lib/api/body";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { UpdateSettingsSchema } from "@/lib/schemas/api";
import { getSettings, updateSettings } from "@/lib/services/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi({ route: "v1.settings.get", auth: "required", rateLimit: "read" }, async ({ requestId, startedAt, user }) => {
  return ok(await getSettings(user!.id), { requestId, startedAt });
});

export const PUT = withApi({ route: "v1.settings.update", auth: "required", rateLimit: "write" }, async ({ req, requestId, startedAt, user }) => {
  const patch = await readJson(req, UpdateSettingsSchema, getEnv().MAX_BODY_BYTES);
  return ok(await updateSettings(user!.id, patch), { requestId, startedAt });
});

export const OPTIONS = preflight;
