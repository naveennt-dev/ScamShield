import { re, rule } from "./shared";
import { findAll, MONEY } from "./matchers";
import type { RuleDefinition } from "../types";

/** Romance/relationship money pleas. */
export const ROMANCE_RULES: RuleDefinition[] = [
  rule(
    {
      id: "romance.money_plea",
      category: "romance",
      severity: "medium",
      weight: 0.3,
      description: "Affectionate message combined with an emergency or gift that needs your money.",
    },
    (t) =>
      t.length < 4000
        ? findAll(t, [
            re(String.raw`\b(my love|darling|sweetheart|honey|my dear|babe|baby)\b`),
            re(String.raw`\b(gift|parcel|customs|hospital|stuck|stranded|visa|ticket|emergency|surgery|airport)\b`),
            re(String.raw`\b(send|transfer|pay|wire|gift card|money|${MONEY})`),
          ])
        : null,
  ),
];
