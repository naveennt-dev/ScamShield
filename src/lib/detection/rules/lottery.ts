import { HI_GAP, re, rule } from "./shared";
import { findAny, MONEY } from "./matchers";
import type { RuleDefinition } from "../types";

/** Prize and lottery claims. */
export const LOTTERY_RULES: RuleDefinition[] = [
  rule(
    {
      id: "prize.winner_claim",
      category: "lottery",
      severity: "high",
      weight: 0.45,
      description: "Claims you won a prize, lottery or lucky draw you never entered.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(you have|you've|u have|you|your number|your mobile number|your sim)\b[^.!?\n]{0,25}?\b(won|win|been selected|selected as)\b[^.!?\n]{0,50}?\b(prize|lottery|lakh|lac|crore|cash|car|iphone|reward|gift|jackpot|bumper|amount|${MONEY})`),
        re(String.raw`\b(lucky winner|lucky customer|bumper prize|mega prize)\b`),
        // "lottery"/"lucky draw" alone is just a topic ("bought two lottery tickets"); a claim needs a win.
        re(String.raw`\b(lottery|lucky draw|jackpot|kbc|contest)\b[^.!?\n]{0,60}?\b(won|winner|win|claim|selected|congratulations|prize money)\b|\b(congratulations|you won|you have won|winner)\b[^.!?\n]{0,60}?\b(lottery|lucky draw|jackpot|kbc|contest)\b`),
        re(String.raw`\b(lottery|inaam|inam|prize)\b[^.!?\n]{0,30}?\b(jeeti|jeeta|jeete|jeet gaye|mila hai|lagi hai)\b`),
        re(`(?:लॉटरी|इनाम|पुरस्कार)${HI_GAP(40)}(?:जीत|जीती|मिला|लगी)`),
      ]),
  ),
];
