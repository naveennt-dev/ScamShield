import { re, rule } from "./shared";
import { findAll, findAny } from "./matchers";
import type { RuleDefinition } from "../types";

/** Guaranteed returns, crypto/trading promises. */
export const INVESTMENT_RULES: RuleDefinition[] = [
  rule(
    {
      id: "invest.crypto_doubling",
      category: "investment",
      severity: "high",
      weight: 0.55,
      description: "Promises to send back double the crypto you send ('giveaway') — always a scam.",
    },
    (t) =>
      findAll(t, [
        // The gap allows a decimal point between digits ("send 0.1 btc") but still stops at sentence ends.
        re(String.raw`\b(send|deposit|transfer)\b(?:[^.!?\n]|(?<=\d)\.(?=\d)){0,30}?\b(btc|bitcoin|eth|ether(eum)?|usdt|crypto|bnb|sol)\b`),
        re(String.raw`\b(get|receive|send you|return)\b[^.!?\n]{0,30}?\b(double|2x|twice|back instantly|\d+(\.\d+)? (btc|eth|usdt) back)\b|\bgiveaway\b`),
      ]),
  ),
  rule(
    {
      id: "invest.guaranteed_returns",
      category: "investment",
      severity: "high",
      weight: 0.5,
      description: "Promises guaranteed or unrealistically high investment returns.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(guaranteed|assured|fixed|risk[- ]free|100%)\s+(returns?|profits?|income|gains?)\b`),
        re(String.raw`\bdouble\s+(your|the)\s+(money|investment|amount)\b`),
        re(String.raw`\b(paisa|paise|rupaye)\s+double\b|\bdouble\s+karo\b`),
        re(String.raw`\b\d{1,3}\s?%\s+(daily|weekly|monthly|per day|per week|per month|a day|a week)\s+(returns?|profits?|interest|income)\b`),
        re(String.raw`\b(returns?|profits?)\s+of\s+\d{1,3}\s?%\s+(daily|weekly|per day|per week|in \d+ days?)\b`),
      ]),
  ),
  rule(
    {
      id: "invest.crypto_trading_promise",
      category: "investment",
      severity: "medium",
      weight: 0.3,
      description: "Promotes crypto/trading profits or a 'VIP' trading group.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(crypto|bitcoin|btc|usdt|ethereum|forex|binary option|trading|stock tips|ipo allotment)\b[^.!?\n]{0,60}?\b(profit|returns?|earn|double|guaranteed|multiply|x\d+)\b`),
        re(String.raw`\b(vip|premium|exclusive)\s+(trading|investment|stock|crypto|signals?)\s+(group|channel|club)\b`),
        re(String.raw`\bjoin\b[^.!?\n]{0,20}?\b(vip|premium|exclusive|private)\s+(group|channel|club)\b`),
      ]),
  ),
];
