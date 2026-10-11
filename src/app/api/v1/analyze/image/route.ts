import { getEnv } from "@/lib/config/env";
import { readBodyBytes } from "@/lib/api/body";
import { ApiError } from "@/lib/api/errors";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { maskSensitiveText } from "@/lib/observability/redact";
import { ImageValidationError, validateImage } from "@/lib/ocr/image-validation";
import { getOcrProvider, OcrError, runOcr } from "@/lib/ocr/provider";
import { AnalysisModeSchema } from "@/lib/schemas/api";
import { analyzeAndStore } from "@/lib/services/analysis-service";
import { recordEvent } from "@/lib/services/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MULTIPART_OVERHEAD = 64 * 1024;

export const POST = withApi(
  { route: "v1.analyze.image", auth: "optional", rateLimit: "analyze_image", anonymousAnalysis: true },
  async ({ req, requestId, startedAt, user, log }) => {
    const env = getEnv();
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Upload the screenshot as multipart/form-data in the 'image' field.");
    }
    if (!getOcrProvider().available) throw new ApiError("SERVICE_UNAVAILABLE", "Screenshot analysis is not enabled on this server.");

    const raw = await readBodyBytes(req, env.MAX_IMAGE_BYTES + MULTIPART_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new ApiError("VALIDATION_ERROR", "The upload could not be read.");
    }
    const file = form.get("image");
    if (!(file instanceof File)) {
      throw new ApiError("VALIDATION_ERROR", undefined, { details: [{ path: "image", message: "is required" }] });
    }
    if (file.size > env.MAX_IMAGE_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", `Images can be at most ${(env.MAX_IMAGE_BYTES / 1048576).toFixed(0)} MB.`);

    const bytes = new Uint8Array(await file.arrayBuffer());
    let info;
    try {
      // Ignores the client-declared MIME type (file.type); trusts only magic bytes + header parse.
      info = validateImage(bytes, file.name || null);
    } catch (e) {
      if (e instanceof ImageValidationError) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", e.message);
      throw e;
    }

    let ocr;
    try {
      ocr = await runOcr(bytes);
    } catch (e) {
      const code = e instanceof OcrError ? e.code : "OCR_FAILED";
      log.warn("ocr_failed", { code });
      recordEvent({ eventType: "OCR_FAILED", requestId, userId: user?.id ?? null, inputType: "image", errorCode: code });
      throw new ApiError("SERVICE_UNAVAILABLE", "We could not read text from this image. Try a clearer screenshot or paste the text.");
    }

    const text = ocr.text.replace(/\s+\n/g, "\n").trim().slice(0, env.MAX_MESSAGE_LENGTH);
    if (text.replace(/\W/g, "").length < 4) {
      throw new ApiError("UNPROCESSABLE", "No readable text was found in the image.");
    }

    // Only the OCR text can ever be sent for remote analysis — never the image.
    const mode = AnalysisModeSchema.safeParse(form.get("analysisMode") ?? undefined);
    if (!mode.success) throw new ApiError("VALIDATION_ERROR", undefined, { details: [{ path: "analysisMode", message: "must be local or remote-assisted" }] });
    const result = await analyzeAndStore({
      inputType: "image",
      text,
      remoteAnalysis: mode.data === "remote-assisted",
      previewText: `[Screenshot] ${text}`,
      requestId,
      userId: user?.id ?? null,
    });
    if (ocr.confidence !== null && ocr.confidence < 0.6) {
      result.warnings.push("The text in this image was hard to read; results may be less accurate.");
    }
    return ok(
      {
        ...result,
        ocr: {
          provider: ocr.provider,
          confidence: ocr.confidence,
          latencyMs: ocr.latencyMs,
          image: { type: info.mime, width: info.width, height: info.height },
          extractedText: maskSensitiveText(text).slice(0, 2000),
        },
      },
      { requestId, startedAt },
    );
  },
);

export const OPTIONS = preflight;
