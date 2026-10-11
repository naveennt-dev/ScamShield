import { getEnv } from "@/lib/config/env";
import { readJson } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { analyzeEmailMetadata } from "@/lib/email/analyzer";
import { AnalyzeEmailSchema } from "@/lib/schemas/api";
import { analyzeAndStore } from "@/lib/services/analysis-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(
  { route: "v1.analyze.email", auth: "optional", rateLimit: "analyze_email", anonymousAnalysis: true },
  async ({ req, requestId, startedAt, user }) => {
    const env = getEnv();
    const input = await readJson(req, AnalyzeEmailSchema, env.MAX_BODY_BYTES * 2);
    const text = `Subject: ${input.subject}\n\n${input.body}`;
    if (text.length > env.MAX_MESSAGE_LENGTH + 1100) {
      throw new ApiError("PAYLOAD_TOO_LARGE", `Email body can be at most ${env.MAX_MESSAGE_LENGTH} characters.`);
    }

    const meta = analyzeEmailMetadata(input);
    const result = await analyzeAndStore({
      inputType: "email",
      text,
      extraSignals: meta.signals,
      previewText: `${meta.sender.domain ?? "unknown sender"} — ${input.subject}`,
      requestId,
      userId: user?.id ?? null,
    });
    return ok(
      {
        ...result,
        email: {
          sender: { displayName: meta.sender.displayName, domain: meta.sender.domain },
          replyToDomain: meta.replyTo?.domain ?? null,
          authResults: meta.authResults,
          attachments: meta.attachments.map((a) => ({ filename: a.filename, risk: a.risk, reason: a.reason })),
        },
      },
      { requestId, startedAt },
    );
  },
);

export const OPTIONS = preflight;
