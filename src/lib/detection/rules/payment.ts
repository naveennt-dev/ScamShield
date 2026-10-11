import { HI_GAP, re, rule } from "./shared";
import { findAll, findAny, findNonNegated, MONEY } from "./matchers";
import type { RuleDefinition } from "../types";

/** Payment demands, advance fees, UPI refund/collect/QR tricks, "PIN to receive". */
export const PAYMENT_RULES: RuleDefinition[] = [
  rule(
    {
      id: "pay.emergency_money_request",
      category: "other",
      severity: "high",
      weight: 0.45,
      description: "Asks you to send money urgently with an emergency story (stuck, lost phone, new number, hospital) — verify by calling the person on a number you already know.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(stuck|stranded|lost my (phone|wallet|card)|dropped my phone|new number|my card (is ?n['o]?t|isn't|is not) working|accident|in hospital|emergency|urgent(ly)?|mushkil mein|phas gaya|phas gayi)\b`),
        re(String.raw`\b(send|transfer|pay|lend|bhej(o|do|dena|iye)?)\b[^.!?\n]{0,40}?(\b(rs\.?|inr|₹)?\s?\d[\d,]{2,}\b|\bmoney\b|\bpaise\b|\bupi\b|[\w.-]+@(ybl|okaxis|oksbi|okhdfcbank|okicici|paytm|ibl|axl|upi|apl)\b)`),
      ]),
  ),
  rule(
    {
      id: "upi.pin_to_receive",
      category: "upi",
      severity: "high",
      weight: 0.65,
      description: "Claims you must enter your PIN to RECEIVE money. Receiving money never requires a PIN.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(enter|put|type|use)\b[^.!?\n]{0,40}\bpin\b[^.!?\n]{0,50}\b(receive|get|credit(ed)?|claim|accept|refund|cashback|reward)\b`),
        re(String.raw`\b(to|for)\s+(receive|get|claim|accept)\b[^.!?\n]{0,50}\b(enter|put|type)\b[^.!?\n]{0,30}\bpin\b`),
        // Hinglish: "receive karne ke liye UPI PIN daaliye"
        re(String.raw`\b(receive|paane|lene|prapt)\b[^.!?\n]{0,40}?\b(upi\s*)?pin\b[^.!?\n]{0,20}?\b(daaliye|daalo|dalo|daalein|daliye|enter karo|enter karein|enter kare|bharo)\b`),
        // Hindi: "पैसे पाने के लिए यूपीआई पिन डालें"
        re(`(?:पाने|प्राप्त|रिफंड)${HI_GAP(40)}(?:पिन|pin)${HI_GAP(20)}(?:डालें|डालिए|दर्ज करें)`),
      ]),
  ),
  rule(
    {
      id: "pay.advance_fee",
      category: "other",
      severity: "medium",
      weight: 0.35,
      description: "Demands an upfront fee, deposit or tax before you can receive something.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(processing|registration|clearance|customs|delivery|release|activation|verification|security|joining|training|insurance|gst|transfer|courier|handling|unlock(ing)?)\s+(fee|fees|charge|charges|deposit|tax|amount)\b`),
        re(String.raw`\b(refundable|small|nominal|one[- ]time)\s+(fee|deposit|charge|payment)\b`),
      ]),
  ),
  rule(
    {
      id: "pay.money_request",
      category: "other",
      severity: "low",
      weight: 0.15,
      description: "Asks you to pay or transfer money.",
    },
    (t) => findNonNegated(t, [re(String.raw`\b(?<verb>pay|transfer|deposit|send)\b[^.!?\n]{0,30}?(${MONEY})`)]),
  ),
  rule(
    {
      id: "upi.refund_bait",
      category: "upi",
      severity: "medium",
      weight: 0.35,
      description: "Offers a refund/cashback that requires you to approve, scan or click something.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(refund|cash ?back|reward|reimbursement|electricity bill|bill payment)\b[^.!?\n]{0,70}?\b(approve|accept|scan|collect request|click|tap|claim|enter|link|upi id|pin)\b`),
      ]),
  ),
  rule(
    {
      id: "upi.collect_or_qr",
      category: "upi",
      severity: "high",
      weight: 0.5,
      description: "Asks you to scan a QR code or approve a UPI request to RECEIVE money — this actually sends money out.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(scan|approve|accept)\b[^.!?\n]{0,30}?\b(qr|qr code|collect request|payment request|request)\b[^.!?\n]{0,50}?\b(receive|get|refund|cash ?back|prize|credit(ed)?|claim)\b`),
        re(String.raw`\b(receive|get|claim)\b[^.!?\n]{0,40}?\b(scan|approve|accept)\b[^.!?\n]{0,20}?\b(qr|collect|request)\b`),
      ]),
  ),
];
