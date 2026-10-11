import { snippet, type MatchHit } from "./matchers";
import type { RuleContext, RuleDefinition } from "../types";

/**
 * Rule-building helpers shared by every rule family.
 *
 * Weights are 0–1 contributions to a noisy-OR score (see ../rule-engine.ts). Rough intent:
 *  - one high-severity "dangerous request" rule alone ⇒ ~50–65
 *  - weak/contextual rules (urgency, fear, links) ⇒ 10–15 each, only matter in combination
 *  - combos reward co-occurring tactics
 * Hand-set starting points — tune against labelled data (docs/detection/rules.md).
 */

/** Global + match-indices ("d") so negation checks can locate a named `verb` group. */
export const re = (src: string) => new RegExp(src, "gd");
export type Finder = (text: string, ctx: RuleContext) => MatchHit | null;

export function rule(def: Omit<RuleDefinition, "evaluate">, find: Finder): RuleDefinition {
  return {
    ...def,
    evaluate(ctx) {
      const hit = find(ctx.text.lower, ctx);
      return hit ? snippet(ctx.text.lower, hit) : null;
    },
  };
}

/**
 * Verbs that hand a secret to *someone else*. Deliberately excludes "enter/verify/use", which
 * legitimate OTP messages use ("use OTP 123456 to verify your login").
 */
export const SHARE_VERBS = "share|send|tell|give|provide|forward|reply with|reply|read out|disclose|dictate|sms|whatsapp|confirm (?:it|the \\w+)? ?(?:to|with)";
/** Hinglish request verbs ("tell/send/give/share it"). */
export const HINGLISH_SHARE_VERBS = "batao|bata do|batayein|bataiye|bata dijiye|bhejo|bhej do|bhejiye|bhejein|share karo|share kare|share karein|share kijiye|de do|dijiye|forward karo";
/** Hindi (Devanagari) request verbs. No \b: JavaScript word boundaries are ASCII-only. */
export const HI_SHARE_VERBS = "बताइए|बताइये|बताएं|बताएँ|बताओ|बता दें|भेजें|भेजो|भेजिए|भेज दें|शेयर करें|शेयर कीजिए|साझा करें|साझा कीजिए";
/** Sentence-bounded gap that also stops at the Devanagari danda (।). */
export const HI_GAP = (n: number) => `[^.!?\\n\u0964]{0,${n}}?`;

export const OTP = "otp|one[- ]time password|verification code|security code|auth(?:entication)? code|\\d[- ]digit code";
