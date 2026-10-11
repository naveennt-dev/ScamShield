import { z } from "zod";
import { ScamCategorySchema } from "./analysis";

/**
 * Request schemas for the public API. Limits here are hard upper bounds; the configurable
 * MAX_MESSAGE_LENGTH (env) is enforced additionally in the route handlers.
 */

export const HARD_MAX_MESSAGE_CHARS = 100_000;

/**
 * Per-request consent for remote analysis (Phase 4). "local" (the default) never contacts any
 * external service. "remote-assisted" additionally sends minimised text to OpenRouter — only if
 * the server also has it enabled (LLM_ENABLED) and configured with a free model.
 */
export const AnalysisModeSchema = z.enum(["local", "remote-assisted"]).optional().default("local");
export type AnalysisMode = "local" | "remote-assisted";

const nonBlank = (max: number) =>
  z
    .string({ required_error: "is required", invalid_type_error: "must be a string" })
    .max(max, `must be at most ${max} characters`)
    .refine((s) => s.trim().length > 0, "must not be empty");

export const AnalyzeMessageSchema = z
  .object({
    message: nonBlank(HARD_MAX_MESSAGE_CHARS),
    /** Optional hint where the message came from; never trusted for scoring. */
    channel: z.enum(["sms", "whatsapp", "email", "social", "call_transcript", "other"]).optional(),
    analysisMode: AnalysisModeSchema,
    /**
     * "screen": OCR text from a screen/region scan — analysed block by block (see
     * detection/screen.ts). "text" (default): a message the user pasted or typed.
     */
    source: z.enum(["text", "screen"]).optional().default("text"),
  })
  .strict();
export type AnalyzeMessageInput = z.infer<typeof AnalyzeMessageSchema>;

export const AnalyzeUrlSchema = z
  .object({
    url: nonBlank(4096),
    /** Opt-in: resolve redirects through the SSRF-safe fetcher (also requires URL_FETCH_ENABLED). */
    followRedirects: z.boolean().optional().default(false),
  })
  .strict();
export type AnalyzeUrlInput = z.infer<typeof AnalyzeUrlSchema>;

export const AttachmentMetaSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(255).optional(),
    sizeBytes: z.number().int().min(0).max(1024 * 1024 * 1024).optional(),
  })
  .strict();
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export const AnalyzeEmailSchema = z
  .object({
    from: z.string().min(1).max(512),
    replyTo: z.string().max(512).optional(),
    subject: z.string().max(1000).default(""),
    body: z.string().max(HARD_MAX_MESSAGE_CHARS).default(""),
    /** Raw `Authentication-Results` header value(s), if the user has them. */
    authenticationResults: z.string().max(4000).optional(),
    attachments: z.array(AttachmentMetaSchema).max(50).default([]),
  })
  .strict()
  .refine((e) => e.subject.trim().length > 0 || e.body.trim().length > 0, {
    message: "subject or body is required",
    path: ["body"],
  });
export type AnalyzeEmailInput = z.infer<typeof AnalyzeEmailSchema>;

export const CreateReportSchema = z
  .object({
    reportType: z.enum(["message", "url", "other"]),
    /** Message text or URL being reported. Stored only as fingerprint + masked preview. */
    content: nonBlank(HARD_MAX_MESSAGE_CHARS),
    category: ScamCategorySchema,
    analysisId: z.string().max(64).optional(),
    note: z.string().max(1000).optional(),
    /** Phase 5: the reporter's verdict. A false-positive report never counts towards a scam pattern. */
    verdict: z.enum(["scam", "suspicious", "false_positive"]).optional().default("scam"),
  })
  .strict();
export type CreateReportInput = z.infer<typeof CreateReportSchema>;

export const HistoryQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  classification: z.enum(["safe", "suspicious", "scam"]).optional(),
  inputType: z.enum(["message", "url", "image", "email"]).optional(),
});

export const UpdateSettingsSchema = z
  .object({
    storeContentPreview: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    allowLlmAnalysis: z.boolean().optional(),
  })
  .strict();
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
