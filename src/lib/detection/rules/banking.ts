import { HI_GAP, re, rule } from "./shared";
import { findAll, findAny } from "./matchers";
import type { RuleDefinition } from "../types";

/** Bank account threats and bank-brand calls to action. */
export const BANKING_RULES: RuleDefinition[] = [
  rule(
    {
      id: "bank.account_threat",
      category: "banking",
      severity: "medium",
      weight: 0.3,
      description: "Threatens that your account, card, SIM or wallet will be blocked or suspended.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(account|khata|a\/c|wallet|sim)\b[^.!?\n]{0,30}?\b(band|bandh|block)\s+(ho\s+)?(jayega|jaega|jaayega|ho jayega|kar diya jayega|hoga)\b`),
        re(`(?:खाता|अकाउंट|सिम)${HI_GAP(30)}(?:बंद|ब्लॉक)\\s*(?:कर दिया जाएगा|हो जाएगा|हो जायेगा|किया जाएगा)`),
        re(String.raw`\b(account|a\/c|card|sim|wallet|number|connection|service|profile|pan|net ?banking)\b[^.!?\n]{0,35}?\b(will be|has been|have been|is being|is|are|gets?|getting|to be)\s+(temporarily\s+|permanently\s+)?(blocked|suspended|deactivated|frozen|freezed|closed|terminated|disabled|locked|disconnected|barred)\b`),
      ]),
  ),
  rule(
    {
      id: "bank.impersonation_cta",
      category: "banking",
      severity: "low",
      weight: 0.18,
      description: "Uses a bank or payment brand name together with a request to click, call or verify.",
    },
    (t) =>
      findAll(t, [
        // (?<![@.\w]) — ignore UPI handles/domains like "zomato@icici" or "x.paytm": not a brand claim.
        re(String.raw`(?<![@.\w])(sbi|hdfc|icici|axis bank|kotak|pnb|bank of baroda|canara|union bank|yes bank|indusind|paytm|phonepe|google ?pay|gpay|bhim|npci|rbi|reserve bank)\b`),
        re(String.raw`\b(click|tap|visit|open|call|contact|verify|update|link|download)\b`),
      ]),
  ),
];
