import { getAIProvider, type AIProvider } from "@/lib/ai/provider";
import { AIError } from "@/lib/ai/errors";
import { minimizeForRemote } from "@/lib/ai/minimize";
import type { ScamAIResult } from "@/lib/ai/schemas";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import { explainDecision } from "./decision";
import { fuseRisk } from "./risk-engine";
import type { FusionInput } from "./types";
import {
  CATEGORY_LABELS,
  type AnalysisResult,
  type Indicator,
  type InputType,
  type UrlFinding,
} from "@/lib/schemas/analysis";
import { analyzeUrls } from "@/lib/url/service";
import { intelSignal, prismaIntelService, type IntelService, type PatternMatch } from "@/lib/intel/service";
import { buildExplanation, buildReasons, buildRecommendations } from "./explain";
import { fingerprint, simhash } from "./fingerprint";
import type { MlPrediction } from "./ml/classifier";
import { createMlEngine, type MlEngine } from "./ml";
import { preprocess } from "./preprocess";
import { runRules } from "./rule-engine";
import type { RuleSignal } from "./types";

/**
 * Detection pipeline (input-type agnostic):
 *
 *   preprocess → [URL analysis ‖ intel lookup] → rules → ML → LLM (optional) → fusion
 *             → explanation + recommendations → AnalysisResult
 *
 * The LLM (remote, OpenRouter) is optional and OFF unless the server enables it AND the client
 * asks for it on this request. Only minimised text is sent (see `minimizeForRemote`). Any remote
 * failure degrades to the local result with a diagnostic; it never fails the request, and the
 * risk engine never lets a remote verdict lower the local score.
 */

export interface PipelineDeps {
  ai?: AIProvider | null;
  /** ML engine (local Python service with embedded fallback). null disables ML. */
  ml?: MlEngine | null;
  intel?: IntelService | null;
}

export interface PipelineInput {
  inputType: InputType;
  text: string;
  requestId: string;
  /** Remote analysis allowed for this request (per-request opt-in AND account setting). */
  allowLlm: boolean;
  /** The client asked for remote-assisted analysis (for diagnostics; `allowLlm` decides). */
  remoteRequested?: boolean;
  /** Additional deterministic signals (e.g. email header checks). */
  extraSignals?: RuleSignal[];
  /** URLs supplied out-of-band (e.g. the URL scanner's input). */
  extraUrls?: string[];
  /**
   * What the remote AI may receive instead of `text` (still minimised). Link scans analyse the
   * page's text locally but send the AI only the website address and the list of findings.
   */
  remoteText?: string;
  followRedirects?: boolean;
}

export interface PipelineOutput {
  result: AnalysisResult;
  internals: {
    fingerprint: string;
    simhash: bigint;
    contentLength: number;
    ruleSignals: RuleSignal[];
    ml: MlPrediction | null;
    llm: ScamAIResult | null;
    llmErrorCode: string | null;
    intel: PatternMatch | null;
    timingsMs: Record<string, number>;
  };
}

function urlSignal(findings: UrlFinding[]): FusionInput["url"] {
  if (findings.length === 0) return null;
  const scores = findings.map((f) => f.riskScore).sort((a, b) => b - a);
  const score = Math.min(100, scores[0] + 0.1 * (scores[1] ?? 0));
  const anyFlags = findings.some((f) => f.flags.some((x) => x.severity !== "low"));
  return { available: true, score, confidence: anyFlags ? 0.75 : 0.45 };
}

export async function runPipeline(input: PipelineInput, deps: PipelineDeps = {}): Promise<PipelineOutput> {
  const env = getEnv();
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const log = logger.child({ requestId: input.requestId, component: "pipeline", inputType: input.inputType });

  // 1. Preprocess
  const pre = preprocess(input.text);
  const urlList = [...new Set([...(input.extraUrls ?? []), ...pre.urls.map((u) => u.url)])].slice(0, 20);
  const fp = fingerprint(pre.normalized);
  const sh = simhash(pre.normalized);

  // 2. URL analysis + intel lookup in parallel
  const intel = deps.intel === undefined ? prismaIntelService : deps.intel;
  const tUrl = Date.now();
  const [urlFindings, intelMatch] = await Promise.all([
    analyzeUrls(urlList, {
      followRedirects: input.followRedirects,
      obfuscatedUrls: new Set(pre.urls.filter((u) => u.obfuscated).map((u) => u.url)),
      reputationProviders: intel ? [intel.domainReputation] : [],
      requestId: input.requestId,
    }).catch((error) => {
      metrics.urlAnalysisFailure("exception");
      log.warn("url_analysis_failed", { error });
      warnings.push("Link analysis failed; links were not fully checked.");
      return [] as UrlFinding[];
    }),
    intel ? intel.lookupMessage(fp, sh) : Promise.resolve(null),
  ]);
  timings.urlAndIntel = Date.now() - tUrl;

  // 3. Rules (with extracted + extra URLs visible to link rules)
  const preForRules = {
    ...pre,
    urls: urlList.map((u) => ({ url: u, raw: u, bare: false })),
  };
  const rules = runRules(preForRules, [...(input.extraSignals ?? []), ...intelSignal(intelMatch)]);

  // 4. ML
  let ml: MlPrediction | null = null;
  let mlNote: string | undefined;
  const engine = deps.ml === undefined ? createMlEngine() : deps.ml;
  if (env.ML_ENABLED && engine) {
    const tMl = Date.now();
    const outcome = await engine.predict(pre.normalized, input.requestId);
    ml = outcome.prediction;
    mlNote = outcome.note;
    if (!ml) {
      warnings.push("The ML classifier was unavailable; result is based on the safety rules and link checks.");
    } else if (ml.seedModel) {
      warnings.push("The ML model was trained only on a small illustrative dataset; its weight is reduced.");
    }
    timings.ml = Date.now() - tMl;
  } else {
    mlNote = "ML disabled by configuration";
  }
  const mlUsable = Boolean(ml && ml.knownTerms >= 2);
  if (ml && !mlUsable) mlNote = "Too little recognisable text for the ML model";

  // 5. Remote LLM (optional, explicit opt-in, never fatal)
  let llm: ScamAIResult | null = null;
  let llmStatus: "ok" | "fallback" | "unavailable" | "disabled" | "skipped" = "disabled";
  let llmErrorCode: string | null = null;
  const remote: AnalysisResult["remoteAnalysis"] = {
    requested: Boolean(input.remoteRequested ?? input.allowLlm),
    used: false,
    status: "not_requested",
    model: null,
    reason: null,
    sentChars: 0,
  };
  if (!input.allowLlm) {
    // Default path: nothing is sent anywhere — the AI provider is not even constructed.
    llmStatus = env.LLM_ENABLED ? "skipped" : "disabled";
    if (remote.requested) {
      remote.status = "not_configured";
      remote.reason = "REMOTE_NOT_ALLOWED_FOR_ACCOUNT";
    }
  } else if (!env.LLM_ENABLED) {
    llmStatus = "disabled";
    remote.status = "disabled_on_server";
    remote.reason = "LLM_ENABLED=false";
    warnings.push("Remote analysis is turned off on this ScamShield service; the local result is shown.");
  } else {
    const ai = deps.ai === undefined ? getAIProvider() : deps.ai;
    if (!ai || !ai.available) {
      llmStatus = "unavailable";
      remote.status = "not_configured";
      remote.reason = "NOT_CONFIGURED";
      warnings.push("The AI second opinion isn't set up on this ScamShield service; the local result is shown.");
    } else {
      const tLlm = Date.now();
      const minimized = minimizeForRemote(input.remoteText ?? input.text, env.OPENROUTER_MAX_INPUT_CHARS);
      try {
        const hints = rules.signals.slice(0, 8).map((s) => s.description);
        for (const u of urlFindings.slice(0, 3)) if (u.riskScore >= 30) hints.push(`Link to ${u.hostname} scored ${u.riskScore}/100 by URL checks`);
        remote.sentChars = minimized.text.length;
        // Hard deadline on top of the provider's own budget: the local result is never held
        // hostage by a slow or hanging remote call.
        const deadlineMs = env.OPENROUTER_TOTAL_BUDGET_MS + 2_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          llm = await Promise.race([
            ai.analyzeScam({ text: minimized.text, inputType: input.inputType, hints, requestId: input.requestId }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new AIError("TIMEOUT", `remote analysis exceeded ${deadlineMs} ms`)), deadlineMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        llmStatus = llm.usedFallback ? "fallback" : "ok";
        remote.status = "ok";
        remote.model = llm.modelMetadata.model;
        if (minimized.truncated) warnings.push("Only the first part of a long input was sent for remote analysis.");
      } catch (error) {
        llmStatus = "unavailable";
        llmErrorCode = error instanceof AIError ? error.code : "UNKNOWN";
        remote.status = "unavailable";
        remote.reason = llmErrorCode;
        log.warn("llm_unavailable", { code: llmErrorCode });
        warnings.push("Remote AI analysis was unavailable; the local result is shown.");
      }
      timings.llm = Date.now() - tLlm;
    }
  }

  // 6. Fusion
  const weights = {
    ml: env.RISK_WEIGHT_ML,
    rules: env.RISK_WEIGHT_RULES,
    url: env.RISK_WEIGHT_URL,
    llm: env.RISK_WEIGHT_LLM,
  };
  const fused = fuseRisk(
    {
      rules: {
        available: true,
        score: rules.score,
        confidence: rules.confidence,
        hasCriticalIndicator: rules.hasCriticalIndicator,
        promptInjectionDetected: rules.promptInjectionDetected,
        signalCount: rules.signals.length,
        categoryScores: rules.categoryScores,
        awareness: rules.awareness,
        asksReaderToAct: rules.asksReaderToAct,
      },
      ml: ml
        ? {
            available: mlUsable,
            score: ml.riskScore,
            confidence: ml.confidence,
            category: ml.category,
            categoryProba: ml.categoryProba,
            seedModel: ml.seedModel,
            note: mlNote,
          }
        : null,
      url: urlSignal(urlFindings),
      llm: llm
        ? {
            available: true,
            score: llm.analysis.riskScore,
            confidence: llm.analysis.confidence,
            category: llm.analysis.category,
            classification: llm.analysis.classification,
          }
        : null,
    },
    weights,
    { suspicious: env.RISK_THRESHOLD_SUSPICIOUS, high: env.RISK_THRESHOLD_HIGH, critical: env.RISK_THRESHOLD_CRITICAL },
    { capUncorroboratedMl: env.RISK_CAP_UNCORROBORATED_ML },
  );

  // 7. Explanation + recommendations
  const reasons = buildReasons({
    ruleSignals: rules.signals,
    urls: urlFindings,
    ml: mlUsable ? ml : null,
    intelReporters: intelMatch?.knownPattern ? intelMatch.distinctReporters : 0,
    riskLevel: fused.riskLevel,
  });
  const llmContributed = fused.contributions.find((c) => c.source === "llm")?.effectiveWeight ?? 0;
  if (llm) {
    remote.used = llmContributed > 0;
    if (!remote.used) {
      remote.status = "ignored";
      remote.reason = "DISCARDED_BY_SAFETY_GUARD";
    }
  }
  const recommendedActions = buildRecommendations({
    riskLevel: fused.riskLevel,
    category: fused.category,
    ruleSignals: rules.signals,
    hasUrls: urlFindings.length > 0,
    llmActions: llm && llmContributed > 0 ? llm.analysis.recommendedActions : [],
  });

  const indicators: Indicator[] = [
    ...rules.signals.map((s) => ({
      source: s.ruleId.startsWith("intel.") ? ("intel" as const) : s.ruleId.startsWith("email.") ? ("email" as const) : ("rules" as const),
      type: s.ruleId,
      severity: s.severity,
      evidence: s.evidence.slice(0, 300),
      category: s.category,
    })),
    ...urlFindings.flatMap((u) =>
      u.flags
        .filter((f) => f.severity !== "low")
        .map((f) => ({ source: "url" as const, type: f.id, severity: f.severity, evidence: `${u.hostname}: ${f.detail}`.slice(0, 300) })),
    ),
    ...(llm && llmContributed > 0
      ? llm.analysis.indicators.map((i) => ({ source: "llm" as const, type: i.type, severity: i.severity, evidence: i.evidence }))
      : []),
  ].slice(0, 40);

  const suspiciousEntities = [
    ...new Set([
      ...urlFindings.filter((u) => u.riskScore >= 30).map((u) => u.hostname),
      ...(llm && llmContributed > 0 ? llm.analysis.suspiciousEntities : []),
    ]),
  ].slice(0, 20);

  const result: AnalysisResult = {
    id: null,
    inputType: input.inputType,
    classification: fused.classification,
    riskLevel: fused.riskLevel,
    riskScore: fused.riskScore,
    confidence: fused.confidence,
    category: fused.category,
    categoryLabel: CATEGORY_LABELS[fused.category],
    reasons,
    indicators,
    suspiciousEntities,
    urls: urlFindings,
    recommendedActions,
    explanation: buildExplanation(fused.riskLevel, fused.category),
    aiSummary: llm && llmContributed > 0 ? llm.analysis.explanation : null,
    signals: fused.contributions,
    adjustments: fused.adjustments,
    modelMetadata: {
      llm: llm
        ? { provider: llm.modelMetadata.provider, model: llm.modelMetadata.model, status: llmStatus, attempts: llm.attempts }
        : llmStatus !== "disabled"
          ? { provider: "openrouter", model: "none", status: llmStatus, attempts: 0 }
          : null,
      ml: ml ? { version: `${ml.model.name}@${ml.model.buildId}`, seedModel: ml.seedModel } : null,
    },
    intel: { knownPattern: Boolean(intelMatch?.knownPattern), reportCount: intelMatch?.reportCount ?? 0 },
    remoteAnalysis: remote,
    warnings: [...new Set(warnings)],
    assessment: { status: "complete", reasons: [] },
    model: ml ? { name: ml.model.name, version: ml.model.version, buildId: ml.model.buildId, backend: ml.backend } : null,
    processingTimeMs: Date.now() - t0,
    createdAt: new Date().toISOString(),
  };

  // 8. Assessment completeness: "nothing found" only counts as safe when the detectors that
  // produce that verdict actually ran. A failed detector never silently becomes green.
  const gaps: string[] = [];
  if (rules.failedRules > 0) gaps.push(`${rules.failedRules} safety rule(s) failed to run`);
  if (!ml && !llm) gaps.push(env.ML_ENABLED ? "the local ML model was unavailable and no AI second opinion was available" : "the local ML model is disabled and no AI second opinion was available");
  result.assessment = result.riskLevel === "safe" && gaps.length > 0 ? { status: "insufficient", reasons: gaps } : { status: "complete", reasons: [] };
  if (result.assessment.status === "insufficient") {
    result.warnings = [...new Set([...result.warnings, `Unable to assess reliably: ${gaps.join("; ")}. This is not a safe verdict.`])];
    log.warn("assessment_insufficient", { gaps: gaps.length });
  }

  result.decision = explainDecision({
    result,
    signals: fused.contributions,
    adjustments: fused.adjustments,
    ruleDescriptions: new Map(rules.signals.map((s) => [s.ruleId, s.description])),
    thresholds: { suspicious: env.RISK_THRESHOLD_SUSPICIOUS, high: env.RISK_THRESHOLD_HIGH, critical: env.RISK_THRESHOLD_CRITICAL },
  });

  timings.total = Date.now() - t0;
  metrics.analysis(input.inputType, result.riskLevel);
  log.info("analysis_completed", {
    inputLength: input.text.length,
    urlCount: urlFindings.length,
    ruleScore: rules.score,
    ruleIds: rules.signals.map((s) => s.ruleId),
    mlScore: ml?.riskScore ?? null,
    urlScore: urlSignal(urlFindings)?.score ?? null,
    llmScore: llm?.analysis.riskScore ?? null,
    llmModel: llm?.modelMetadata.model ?? null,
    llmStatus,
    llmErrorCode,
    remoteRequested: remote.requested,
    remoteSentChars: remote.sentChars,
    riskScore: result.riskScore,
    riskLevel: result.riskLevel,
    category: result.category,
    timings,
  });

  return {
    result,
    internals: {
      fingerprint: fp,
      simhash: sh,
      contentLength: input.text.length,
      ruleSignals: rules.signals,
      ml,
      llm,
      llmErrorCode,
      intel: intelMatch,
      timingsMs: timings,
    },
  };
}
