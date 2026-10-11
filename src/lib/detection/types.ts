import type {
  Classification,
  FusionAdjustment,
  RiskLevel,
  ScamCategory,
  Severity,
  SignalContribution,
  SignalSource,
} from "@/lib/schemas/analysis";
import type { PreprocessedText } from "./preprocess";

export interface RuleSignal {
  ruleId: string;
  category: ScamCategory;
  severity: Severity;
  /** Masked snippet showing why the rule fired. */
  evidence: string;
  /** 0–1 contribution in the noisy-OR combination. */
  weight: number;
  /** Plain-language reason shown to users. */
  description: string;
}

export interface RuleContext {
  text: PreprocessedText;
  /** Hostnames of extracted URLs (lower-case). */
  hostnames: string[];
}

export interface RuleDefinition {
  id: string;
  category: ScamCategory;
  severity: Severity;
  weight: number;
  description: string;
  /** Returns the evidence snippet if the rule fires, otherwise null. */
  evaluate(ctx: RuleContext): string | null;
}

export interface ComboDefinition {
  id: string;
  /** Fires when at least one rule from each group matched. Groups are rule-id prefixes or ids. */
  requires: string[][];
  category?: ScamCategory;
  severity: Severity;
  weight: number;
  description: string;
}

export interface RuleEngineResult {
  signals: RuleSignal[];
  /** 0–100 noisy-OR of signal weights. */
  score: number;
  /** 0–1: grows with number and severity of independent signals. */
  confidence: number;
  categoryScores: Partial<Record<ScamCategory, number>>;
  topCategory: ScamCategory | null;
  promptInjectionDetected: boolean;
  /** True if any high-severity sensitive-data or dangerous-action rule fired. */
  hasCriticalIndicator: boolean;
  /** The text talks ABOUT scams (safety tip / news) and asks the reader for nothing. */
  awareness: boolean;
  /** The text asks the reader to act (link, number, pay/send/share/click/install…). */
  asksReaderToAct: boolean;
  /** Rules that threw while evaluating (the check was incomplete). */
  failedRules: number;
}

// ---------------------------------------------------------------- risk engine

export interface SourceSignal {
  available: boolean;
  /** 0–100 */
  score: number;
  /** 0–1 */
  confidence: number;
  note?: string;
}

export interface FusionInput {
  rules: SourceSignal & {
    hasCriticalIndicator: boolean;
    promptInjectionDetected: boolean;
    signalCount: number;
    /** See RuleEngineResult. Optional so callers that predate them keep the old behaviour. */
    awareness?: boolean;
    asksReaderToAct?: boolean;
    categoryScores: Partial<Record<ScamCategory, number>>;
  };
  ml: (SourceSignal & { category: ScamCategory | null; categoryProba: Record<string, number> | null; seedModel: boolean }) | null;
  /** null when the input contains no URLs. */
  url: SourceSignal | null;
  llm: (SourceSignal & { category: ScamCategory; classification: Classification }) | null;
}

export type FusionWeights = Record<SignalSource, number>;

export interface FusionResult {
  riskScore: number;
  confidence: number;
  classification: Classification;
  riskLevel: RiskLevel;
  category: ScamCategory;
  contributions: SignalContribution[];
  adjustments: FusionAdjustment[];
}
