import type { ComboDefinition } from "../types";

/** Co-occurring tactics are much stronger evidence than any single one. */
export const COMBOS: ComboDefinition[] = [
  {
    id: "combo.credential_request_with_link",
    requires: [["cred.", "upi.pin_to_receive"], ["link.", "tactic.link_call_to_action"]],
    category: "phishing",
    severity: "high",
    weight: 0.35,
    description: "Combines a request for sensitive details with a link — a classic phishing pattern.",
  },
  {
    id: "combo.threat_with_link",
    requires: [["kyc.urgent_update", "bank.account_threat", "gov.impersonation_threat"], ["link.", "tactic.link_call_to_action"]],
    severity: "high",
    weight: 0.3,
    description: "Combines a threat (KYC/account block/legal action) with a link to 'fix' it.",
  },
  {
    id: "combo.urgency_with_payment",
    requires: [["tactic.urgency", "tactic.fear_threat"], ["pay.", "upi.", "delivery.held_parcel", "job.fee_required"]],
    severity: "medium",
    weight: 0.2,
    description: "Pressures you to pay quickly.",
  },
  {
    id: "combo.authority_with_payment",
    requires: [["gov.impersonation_threat"], ["pay.", "upi.", "cred."]],
    category: "government_impersonation",
    severity: "high",
    weight: 0.35,
    description: "An 'official' threat combined with a demand for money or details.",
  },
  {
    id: "combo.remote_access_with_banking",
    requires: [["tech.remote_access"], ["cred.", "bank.", "upi.", "pay.", "upi.refund_bait"]],
    category: "tech_support",
    severity: "high",
    weight: 0.35,
    description: "Asks for remote access together with banking/payment activity.",
  },
];

/** Rules that, when present, indicate a request for something nobody legitimate asks for. */
export const CRITICAL_RULES = new Set([
  "cred.otp_request",
  "cred.pin_request",
  "upi.pin_to_receive",
  "cred.card_details",
  "cred.password_request",
  "upi.collect_or_qr",
  "tech.remote_access",
  "malware.app_install",
]);
