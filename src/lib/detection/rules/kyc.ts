import { HI_GAP, re, rule } from "./shared";
import { findAny } from "./matchers";
import type { RuleDefinition } from "../types";

/** KYC urgency (never "contains KYC" alone). */
export const KYC_RULES: RuleDefinition[] = [
  rule(
    {
      id: "kyc.urgent_update",
      category: "kyc",
      severity: "medium",
      weight: 0.35,
      description: "Pressures you to update KYC urgently or face consequences.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(e-?kyc|kyc)\b[^.!?\n]{0,60}?\b(expir\w*|pending|incomplete|not updated|update now|suspend\w*|block\w*|deactivat\w*|within|today|immediately|urgent\w*|24 ?h(ou)?rs?|last date)\b`),
        re(String.raw`\b(expir\w*|pending|incomplete|suspend\w*|block\w*|deactivat\w*|urgent\w*)\b[^.!?\n]{0,40}?\b(e-?kyc|kyc)\b`),
        // Hindi: "केवाईसी समाप्त हो गया है … तुरंत अपडेट करें"
        re(`(?:केवाईसी|kyc)${HI_GAP(50)}(?:समाप्त|एक्सपायर|अपडेट|लंबित|बंद|ब्लॉक)`),
      ]),
  ),
];
