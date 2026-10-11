import { HI_GAP, HI_SHARE_VERBS, HINGLISH_SHARE_VERBS, OTP, re, rule, SHARE_VERBS } from "./shared";
import { findNonNegated, proximity } from "./matchers";
import type { RuleDefinition } from "../types";

/** Requests for secrets: OTP, PIN, CVV/card details, passwords, identity documents. */
export const OTP_RULES: RuleDefinition[] = [
  rule(
    {
      id: "cred.otp_request",
      category: "credential_theft",
      severity: "high",
      weight: 0.55,
      description: "Asks you to share a one-time password (OTP). Legitimate organisations never ask for OTPs.",
    },
    (t) => {
      // Narrow exception: e-commerce "open box" delivery OTPs are shared in person with the courier
      // at the doorstep. Requests to share an OTP to *reschedule* or over a call still fire.
      const inPersonDelivery =
        /\b(with|to) (the |our )?delivery (agent|executive|partner|associate|boy|person)\b[^.!?\n]{0,40}\b(at the time of|upon|on|during) delivery\b/.test(t) &&
        !/\b(reschedul\w*|call|phone|whatsapp|link|click)\b/.test(t);
      if (inPersonDelivery) return null;
      return (
        findNonNegated(t, proximity(SHARE_VERBS, OTP, 40)) ??
        findNonNegated(t, proximity(HINGLISH_SHARE_VERBS, "otp|code|pin", 40)) ??
        findNonNegated(t, [
          re(`(?:ओटीपी|otp|कोड)${HI_GAP(40)}(?<verb>${HI_SHARE_VERBS})`),
          re(`(?<verb>${HI_SHARE_VERBS})${HI_GAP(40)}(?:ओटीपी|otp)`),
        ])
      );
    },
  ),
  rule(
    {
      id: "cred.pin_request",
      category: "upi",
      severity: "high",
      weight: 0.6,
      description: "Asks for your UPI/ATM PIN or MPIN.",
    },
    (t) => findNonNegated(t, proximity(`${SHARE_VERBS}|enter|type|input`, "upi pin|atm pin|m-?pin|card pin|pin number|secret pin|pin(?!\\s?code)", 35)),
  ),
  rule(
    {
      id: "cred.card_details",
      category: "banking",
      severity: "high",
      weight: 0.6,
      description: "Asks for card details such as the CVV, expiry date or full card number.",
    },
    (t) =>
      findNonNegated(t, [
        ...proximity(`${SHARE_VERBS}|enter|confirm|update|verify|fill`, "cvv|cvc|card verification|expiry date|card number|debit card details|credit card details|card details", 40),
      ]),
  ),
  rule(
    {
      id: "cred.password_request",
      category: "credential_theft",
      severity: "high",
      weight: 0.5,
      description: "Asks for your password, net-banking login or account credentials.",
    },
    (t) =>
      findNonNegated(
        t,
        proximity(`${SHARE_VERBS}|confirm|verify|enter`, "password|passcode|net ?banking (?:id|login|credentials|details)|login (?:details|credentials)|user ?id and password|credentials", 40),
      ),
  ),
  rule(
    {
      id: "cred.identity_documents",
      category: "kyc",
      severity: "medium",
      weight: 0.3,
      description: "Asks you to send identity documents (Aadhaar, PAN, passport) over a message or link.",
    },
    (t) =>
      findNonNegated(
        t,
        proximity("send|share|upload|provide|submit|whatsapp|forward", "aadhaa?r|pan card|pan number|passport|voter id|driving licen[cs]e", 40),
      ),
  ),
];
