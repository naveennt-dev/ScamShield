import { re, rule } from "./shared";
import { findAll, findAny } from "./matchers";
import type { RuleDefinition } from "../types";

/** Instant-loan offers and recovery harassment. */
export const LOAN_RULES: RuleDefinition[] = [
  rule(
    {
      id: "loan.instant_offer",
      category: "loan",
      severity: "medium",
      weight: 0.3,
      description: "Instant/pre-approved loan offer with no checks, often followed by fees.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(instant|pre-?approved|guaranteed|urgent)\s+(personal\s+)?(loan|credit)\b[^.!?\n]{0,60}?\b(fee|no (cibil|documents?|credit check)|without (cibil|documents?)|click|apply|link|whatsapp)\b`),
        re(String.raw`\bloan\b[^.!?\n]{0,50}?\b(without (cibil|documents?)|no (cibil|documents?|credit check)|processing fee|bina cibil|bina documents?)\b`),
      ]),
  ),
  rule(
    {
      id: "loan.recovery_harassment",
      category: "loan",
      severity: "medium",
      weight: 0.35,
      description: "Threatens to share your photos or contact your relatives over a loan.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(loan|emi|repay\w*|due amount|outstanding)\b`),
        re(String.raw`\b(photos?|morph\w*|contacts?|relatives|family members|viral|defame|nude)\b[^.!?\n]{0,40}?\b(send|share|send to|leak|post|viral)\b|\b(send|share|leak|post)\b[^.!?\n]{0,40}?\b(photos?|contacts?|relatives|family)\b`),
      ]),
  ),
];
