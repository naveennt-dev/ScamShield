import { maskSensitiveText } from "@/lib/observability/redact";

/**
 * Matching helpers for rules. Rules operate on lower-cased, normalised text.
 *
 * Key design point: many legitimate messages *mention* sensitive things ("never share your OTP",
 * "your KYC is complete"). Rules therefore look for intent (a request verb near a sensitive
 * object, a threat combined with a deadline, …) and skip matches whose request verb is negated.
 */

/** Sentence-bounded gap: does not cross . ! ? or newlines. */
const GAP = (n: number) => `[^.!?\\n\u0964]{0,${n}}?`;

/** Negation immediately before a verb, allowing up to three intervening words ("never ask you to share"). */
const NEGATION_TAIL =
  /(?:\b(never|not|don't|dont|do not|won't|will not|shouldn't|should not|no need to|cannot|can't|nobody|no one|neither|nor|avoid|refuse to|mat|kabhi nahi|kabhi na)|(?:^|\s)(मत|कभी नहीं|कभी न))\s+(?:[\w'\u0900-\u097F]+\s+){0,3}$/;
/** Hinglish/Hindi negate AFTER the verb: "share na karein", "batana nahi", "साझा न करें". */
const NEGATION_AFTER = /^\s+(?:(na|nahi|nahin|mat)\b|(न|ना|नहीं|मत)(?=\s|$|[.,।!?]))/;

export interface MatchHit {
  index: number;
  length: number;
}

export function snippet(text: string, hit: MatchHit, context = 30, max = 180): string {
  const start = Math.max(0, hit.index - context);
  const end = Math.min(text.length, hit.index + hit.length + context);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = `…${s}`;
  if (end < text.length) s = `${s}…`;
  s = maskSensitiveText(s);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Builds forward ("share … otp") and reverse ("otp … share it") proximity regexes. The verb is
 * captured in the named group `verb` so its position can be negation-checked.
 */
export function proximity(verbs: string, targets: string, gap = 40): RegExp[] {
  return [
    new RegExp(`\\b(?<verb>${verbs})\\b${GAP(gap)}\\b(?:${targets})\\b`, "gd"),
    new RegExp(`\\b(?:${targets})\\b${GAP(gap)}\\b(?<verb>${verbs})\\b`, "gd"),
  ];
}

/** First match across regexes whose `verb` group (or match start) is not negated. */
export function findNonNegated(text: string, regexes: RegExp[]): MatchHit | null {
  for (const re of regexes) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const verb = (m as RegExpMatchArray & { indices?: { groups?: Record<string, [number, number]> } }).indices?.groups?.verb;
      const verbStart = verb?.[0] ?? m.index!;
      const verbEnd = verb?.[1] ?? m.index! + m[0].length;
      const before = text.slice(Math.max(0, verbStart - 45), verbStart);
      if (NEGATION_TAIL.test(before)) continue;
      if (NEGATION_AFTER.test(text.slice(verbEnd, verbEnd + 12))) continue;
      return { index: m.index!, length: m[0].length };
    }
  }
  return null;
}

export function findAny(text: string, regexes: RegExp[]): MatchHit | null {
  for (const re of regexes) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) return { index: m.index, length: m[0].length };
  }
  return null;
}

/** All groups must match somewhere in the text; returns the first group's hit. */
export function findAll(text: string, groups: RegExp[]): MatchHit | null {
  let first: MatchHit | null = null;
  for (const re of groups) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) return null;
    first ??= { index: m.index, length: m[0].length };
  }
  return first;
}

/** Money amount: ₹500, rs. 1,000, INR 50000, $200, 5000 rupees, 2 lakh. */
export const MONEY = String.raw`(?:₹|rs\.?|inr|usd|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:rs|rupees|inr|lakhs?|lacs?|crores?|k\b|usd|dollars)`;
