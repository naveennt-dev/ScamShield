import { logger } from "@/lib/observability/logger";
import { runPipeline, type PipelineDeps, type PipelineInput, type PipelineOutput } from "./pipeline";

/**
 * Screen-scan analysis (Phase 6 corrective fix).
 *
 * OCR text from a screen is not one message: a full-screen capture holds chat bubbles, sidebars,
 * other windows and desktop labels. Analysed as one blob, a scam bubble was diluted (the ML saw
 * mostly UI text) and its phrases were broken by OCR line wraps, so real scams came back "safe".
 *
 * Here the text is split into the blocks the Mac app produced (separated by blank lines), soft
 * line-wraps inside a block are joined (OCR wraps are layout, not sentence ends), and every block —
 * plus the whole text — goes through the real pipeline. The riskiest result is returned with its
 * own evidence. Every candidate uses the same detector; nothing is invented or defaulted.
 */

export const MAX_SCREEN_BLOCKS = 30;
const MIN_BLOCK_CHARS = 12;
/**
 * A block is message-like enough for an ML-only verdict from this many words. The ML model was
 * trained on whole messages; on short UI fragments ("Update installed • Restart to update") it
 * produced confident false alarms when every fragment competed for the highest score.
 */
export const MIN_ML_ONLY_WORDS = 12;
/**
 * …and the model must be strongly confident. A screen yields many blocks; letting every fragment
 * compete multiplies the chance that one of them is a model false alarm (measured: this terminal's
 * own tip line scored ML 51 and turned a harmless screen "suspicious"). Blocks with rule or link
 * evidence are not affected.
 */
export const MIN_ML_ONLY_SCORE = 70;

/** Joins OCR soft wraps inside a block ("share the\nOTP" → "share the OTP"). */
export function joinSoftWraps(block: string): string {
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

export function splitScreenBlocks(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map(joinSoftWraps)
    .filter((b) => (b.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_BLOCK_CHARS)
    .slice(0, MAX_SCREEN_BLOCKS);
}

export interface ScreenAnalysis {
  blocks: number;
  analysed: number;
  /** Index of the block the result is about, or null when the whole text scored highest. */
  selectedBlock: number | null;
}

export async function runScreenPipeline(input: PipelineInput, deps: PipelineDeps = {}): Promise<PipelineOutput & { screen: ScreenAnalysis }> {
  const blocks = splitScreenBlocks(input.text);
  const whole = blocks.length > 0 ? blocks.join("\n\n") : joinSoftWraps(input.text);
  const candidates = blocks.length > 1 ? [...blocks, whole] : [whole];

  // Local analysis of every candidate (no remote AI here — at most one remote call below).
  const outputs: PipelineOutput[] = [];
  for (const [i, text] of candidates.entries()) {
    outputs.push(await runPipeline({ ...input, text, allowLlm: false, requestId: `${input.requestId}.${i}` }, deps));
  }
  const rank = (o: PipelineOutput) => o.result.riskScore * 1000 + o.internals.ruleSignals.length;
  // A candidate may win only with real evidence (a safety rule or a risky link) or when it is
  // message-length; the whole text (last candidate) is always eligible.
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const eligible = (i: number) =>
    i === candidates.length - 1 ||
    outputs[i].internals.ruleSignals.length > 0 ||
    outputs[i].result.urls.some((u) => u.riskScore >= 40) ||
    (words(candidates[i]) >= MIN_ML_ONLY_WORDS && (outputs[i].internals.ml?.riskScore ?? 0) >= MIN_ML_ONLY_SCORE);
  // Prefer a specific block: the whole text wins only when it scores strictly higher (cross-block
  // evidence). The block's evidence is more precise, and less text goes to remote AI if requested.
  let best = -1;
  for (let i = 0; i < blocks.length && candidates.length > 1; i++) if (eligible(i) && (best < 0 || rank(outputs[i]) > rank(outputs[best]))) best = i;
  const wholeIndex = candidates.length - 1;
  if (best < 0 || rank(outputs[wholeIndex]) > rank(outputs[best])) best = wholeIndex;

  // Remote assistance (if requested) only for the selected block: minimal text leaves the Mac,
  // and the risk engine still never lets it lower the local score.
  let chosen = outputs[best];
  if (input.allowLlm) {
    chosen = await runPipeline({ ...input, text: candidates[best], requestId: input.requestId }, deps);
  }
  const selectedBlock = blocks.length > 1 && best < blocks.length ? best : null;
  if (blocks.length > 1) {
    chosen.result.warnings = [
      ...new Set([
        ...chosen.result.warnings,
        `The screen contained ${blocks.length} separate text areas; this result is for the riskiest one.`,
      ]),
    ];
  }
  // One correlated diagnostics line per screen scan (ids, counts and verdicts only — never text).
  logger.info("screen_analysis", {
    requestId: input.requestId,
    ocrChars: input.text.length,
    blocks: blocks.length,
    analysed: candidates.length,
    selectedBlock,
    rules: chosen.internals.ruleSignals.map((s) => s.ruleId),
    mlAvailable: Boolean(chosen.internals.ml),
    mlScore: chosen.internals.ml?.riskScore ?? null,
    riskLevel: chosen.result.riskLevel,
    riskScore: chosen.result.riskScore,
    category: chosen.result.category,
    remote: chosen.result.remoteAnalysis.status,
  });
  return { ...chosen, screen: { blocks: blocks.length, analysed: candidates.length, selectedBlock } };
}
