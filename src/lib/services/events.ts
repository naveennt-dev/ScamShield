import { Prisma } from "@prisma/client";
import { prisma, isDatabaseConfigured } from "@/lib/db/prisma";
import { logger } from "@/lib/observability/logger";
import { redactForLog } from "@/lib/observability/redact";

export type EventType =
  | "ANALYSIS_COMPLETED"
  | "LLM_FALLBACK"
  | "LLM_UNAVAILABLE"
  | "RATE_LIMITED"
  | "REPORT_CREATED"
  | "OCR_FAILED"
  | "REQUEST_FAILED";

/**
 * Persists an audit/analytics event. Fire-and-forget: failures are logged, never thrown, and
 * metadata is redacted (no content, no secrets).
 */
export function recordEvent(e: {
  eventType: EventType;
  requestId: string;
  userId?: string | null;
  analysisId?: string | null;
  inputType?: string;
  latencyMs?: number;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  if (!isDatabaseConfigured()) return;
  prisma.analysisEvent
    .create({
      data: {
        eventType: e.eventType,
        requestId: e.requestId,
        userId: e.userId ?? null,
        analysisId: e.analysisId ?? null,
        inputType: e.inputType,
        latencyMs: e.latencyMs,
        errorCode: e.errorCode ?? null,
        metadata: e.metadata ? (redactForLog(e.metadata) as Prisma.InputJsonValue) : undefined,
      },
    })
    .catch((error) => logger.warn("event_persist_failed", { requestId: e.requestId, eventType: e.eventType, error }));
}
