import { Prisma } from "@prisma/client";
import { prisma, isDatabaseConfigured } from "@/lib/db/prisma";
import { runPipeline, type PipelineDeps, type PipelineInput } from "@/lib/detection/pipeline";
import { runScreenPipeline } from "@/lib/detection/screen";
import { sha256, simhashHex } from "@/lib/detection/fingerprint";
import { safePreview } from "@/lib/observability/redact";
import { logger } from "@/lib/observability/logger";
import type { AnalysisResult, Classification, InputType, RiskLevel } from "@/lib/schemas/analysis";
import { recordEvent } from "./events";
import { getSettings } from "./settings-service";

/**
 * Application service: settings-aware pipeline execution + persistence.
 * Anonymous analyses are not stored. Authenticated analyses are stored with a masked preview
 * (if the user allows it) and expire after the user's retention period.
 */

const INPUT_TYPE_DB: Record<InputType, "MESSAGE" | "URL" | "IMAGE" | "EMAIL"> = {
  message: "MESSAGE",
  url: "URL",
  image: "IMAGE",
  email: "EMAIL",
};
const CLASS_DB: Record<Classification, "SAFE" | "SUSPICIOUS" | "SCAM"> = { safe: "SAFE", suspicious: "SUSPICIOUS", scam: "SCAM" };
const LEVEL_DB: Record<RiskLevel, "SAFE" | "SUSPICIOUS" | "HIGH" | "CRITICAL"> = {
  safe: "SAFE",
  suspicious: "SUSPICIOUS",
  high: "HIGH",
  critical: "CRITICAL",
};

export interface AnalyzeRequest extends Omit<PipelineInput, "allowLlm" | "remoteRequested"> {
  userId: string | null;
  /** Explicit per-request consent (`analysisMode: "remote-assisted"`). Default: local only. */
  remoteAnalysis?: boolean;
  /** OCR text from a screen scan: analysed per text block (detection/screen.ts). */
  screenText?: boolean;
  /** Text used for the stored preview (defaults to `text`). */
  previewText?: string;
}

export async function analyzeAndStore(req: AnalyzeRequest, deps: PipelineDeps = {}): Promise<AnalysisResult> {
  const settings = await getSettings(req.userId);
  const remoteRequested = req.remoteAnalysis === true;
  // Remote analysis needs BOTH the per-request opt-in and the account setting (kill switch).
  const pipelineInput = { ...req, remoteRequested, allowLlm: remoteRequested && settings.allowLlmAnalysis };
  const screenOut = req.screenText ? await runScreenPipeline(pipelineInput, deps) : null;
  const { result, internals } = screenOut ?? (await runPipeline(pipelineInput, deps));
  if (screenOut) result.screen = screenOut.screen;

  if (result.modelMetadata.llm?.status === "fallback") {
    recordEvent({ eventType: "LLM_FALLBACK", requestId: req.requestId, userId: req.userId, inputType: req.inputType });
  } else if (result.modelMetadata.llm?.status === "unavailable") {
    recordEvent({
      eventType: "LLM_UNAVAILABLE",
      requestId: req.requestId,
      userId: req.userId,
      inputType: req.inputType,
      errorCode: internals.llmErrorCode,
    });
  }

  if (!req.userId || !isDatabaseConfigured()) {
    recordEvent({
      eventType: "ANALYSIS_COMPLETED",
      requestId: req.requestId,
      inputType: req.inputType,
      latencyMs: internals.timingsMs.total,
      metadata: { riskLevel: result.riskLevel, category: result.category, anonymous: true },
    });
    return result;
  }

  const expiresAt = new Date(Date.now() + settings.retentionDays * 24 * 60 * 60 * 1000);
  try {
    const row = await prisma.scamAnalysis.create({
      data: {
        userId: req.userId,
        requestId: req.requestId,
        inputType: INPUT_TYPE_DB[req.inputType],
        fingerprint: internals.fingerprint,
        simhash: simhashHex(internals.simhash),
        contentPreview: settings.storeContentPreview ? safePreview(req.previewText ?? req.text) : null,
        contentLength: internals.contentLength,
        classification: CLASS_DB[result.classification],
        riskLevel: LEVEL_DB[result.riskLevel],
        riskScore: result.riskScore,
        confidence: result.confidence,
        category: result.category,
        explanation: result.explanation,
        aiSummary: result.aiSummary,
        reasons: result.reasons as Prisma.InputJsonValue,
        recommendedActions: result.recommendedActions as Prisma.InputJsonValue,
        signals: {
          contributions: result.signals,
          warnings: result.warnings,
          intel: result.intel,
          modelMetadata: result.modelMetadata,
        } as unknown as Prisma.InputJsonValue,
        adjustments: result.adjustments as unknown as Prisma.InputJsonValue,
        llmProvider: result.modelMetadata.llm?.provider ?? null,
        llmModel: result.modelMetadata.llm?.model ?? null,
        llmStatus: result.modelMetadata.llm?.status ?? "disabled",
        mlModelVersion: result.modelMetadata.ml?.version ?? null,
        processingTimeMs: internals.timingsMs.total,
        expiresAt,
        indicators: {
          create: result.indicators.map((i) => ({
            source: i.source,
            type: i.type,
            severity: i.severity,
            evidence: i.evidence,
            category: i.category ?? null,
          })),
        },
        urlAnalyses: {
          create: result.urls.map((u) => ({
            urlHash: sha256(u.url),
            hostname: u.hostname,
            domain: u.registrableDomain,
            riskScore: u.riskScore,
            flags: u.flags as unknown as Prisma.InputJsonValue,
            redirectCount: Math.max(0, (u.redirectChain?.length ?? 1) - 1),
            finalDomain: u.finalUrl ? safeHost(u.finalUrl) : null,
          })),
        },
      },
      select: { id: true },
    });
    recordEvent({
      eventType: "ANALYSIS_COMPLETED",
      requestId: req.requestId,
      userId: req.userId,
      analysisId: row.id,
      inputType: req.inputType,
      latencyMs: internals.timingsMs.total,
      metadata: { riskLevel: result.riskLevel, category: result.category, llmStatus: result.modelMetadata.llm?.status ?? "disabled" },
    });
    return { ...result, id: row.id };
  } catch (error) {
    // Persistence failure must not hide the safety verdict from the user.
    logger.error("analysis_persist_failed", { requestId: req.requestId, error });
    return { ...result, warnings: [...result.warnings, "This result could not be saved to your history."] };
  }
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}
