import { getEnv } from "@/lib/config/env";
import { readJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { AnalyzeMessageSchema } from "@/lib/schemas/api";
import { analyzeAndStore } from "@/lib/services/analysis-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(
  { route: "v1.analyze.message", auth: "optional", rateLimit: "analyze_message", anonymousAnalysis: true },
  async ({ req, requestId, startedAt, user }) => {
    const env = getEnv();
    const body = await readJson(req, AnalyzeMessageSchema, env.MAX_BODY_BYTES);
    if (body.message.length > env.MAX_MESSAGE_LENGTH) {
      throw new ApiError("PAYLOAD_TOO_LARGE", `Messages can be at most ${env.MAX_MESSAGE_LENGTH} characters.`);
    }
    const result = await analyzeAndStore({
      inputType: "message",
      text: body.message,
      requestId,
      userId: user?.id ?? null,
      remoteAnalysis: body.analysisMode === "remote-assisted",
      screenText: body.source === "screen",
    });
    return ok(result, { requestId, startedAt });
  },
);

export const OPTIONS = preflight;
