import { HI_GAP, re, rule } from "./shared";
import { findAll, findAny } from "./matchers";
import type { RuleDefinition } from "../types";

/**
 * Everyday-service threats (corrective fix — gaps found by the realistic evaluation set):
 * electricity / gas / SIM disconnection threats with a deadline, the classic "your power will be
 * cut tonight, call our officer" scam (English, Hinglish, Hindi).
 */

/** Scheduled-maintenance notices are genuine; they announce an outage, they don't threaten one. */
const MAINTENANCE = /\b(scheduled|planned|maintenance|shutdown for repair|will be restored|inconvenience is regretted)\b/i;

export const UTILITY_RULES: RuleDefinition[] = [
  rule(
    {
      id: "utility.disconnection_threat",
      category: "other",
      severity: "high",
      weight: 0.45,
      description: "Threatens to cut your electricity, gas or phone connection soon unless you act — a common bill-payment scam.",
    },
    (t) => {
      if (MAINTENANCE.test(t)) return null;
      return (
        findAll(t, [
          re(String.raw`\b(electricity|power|light|gas|water|water supply|supply|connection|sim|mobile number|number|meter)\b[^.!?\n]{0,60}?\b(will be|would be|is being|shall be|to be)\s+(dis ?connected|cut|blocked|deactivated|suspended|stopped)\b`),
          re(String.raw`\b(tonight|today|within \d+ ?(hours?|hrs?|minutes?)|immediately|urgently|9[.:]30 ?pm|\d{1,2}[.:]\d{2} ?pm)\b`),
        ]) ??
        // Hinglish: "aaj raat light kaat di jayegi", "bijli connection kat jayega"
        findAll(t, [
          re(String.raw`\b(bijli|light|connection|gas|sim)\b[^.!?\n]{0,50}?\b(kaat|kaat di|kat|kaatna|band)\b[^.!?\n]{0,20}?\b(jayegi|jayega|jaayegi|jaayega|di jayegi|diya jayega|ho jayega|ho jayegi|karenge)\b`),
          re(String.raw`\b(aaj|aaj raat|turant|abhi|jaldi|\d+ ghante)\b`),
        ]) ??
        // Hindi: "आज रात बिजली काट दी जाएगी"
        findAny(t, [re(`(?:बिजली|कनेक्शन|गैस|सिम)${HI_GAP(40)}(?:काट दी जाएगी|काट दिया जाएगा|बंद कर दिया जाएगा|बंद हो जाएगा)`)])
      );
    },
  ),
];
