import { CATEGORY_LABELS, type RiskLevel, type ScamCategory, type UrlFinding } from "@/lib/schemas/analysis";
import type { MlPrediction } from "./ml/classifier";
import type { RuleSignal } from "./types";

/**
 * Deterministic explanation + recommendation generator. Produces plain-language output that
 * does not depend on the LLM, so users always get a "why" — even when OpenRouter is down.
 */

const LEVEL_SENTENCE: Record<RiskLevel, (cat: string) => string> = {
  critical: (c) => `This is almost certainly a scam${c ? ` (${c})` : ""}. Do not respond or act on it.`,
  high: (c) => `This shows strong signs of a scam${c ? ` (${c})` : ""}.`,
  suspicious: (c) => `This has some warning signs${c ? ` typical of a ${c}` : ""}. Treat it with caution and verify independently.`,
  safe: () => "We did not find known scam indicators. Stay cautious anyway: scammers change tactics often.",
};

export function buildReasons(opts: {
  ruleSignals: RuleSignal[];
  urls: UrlFinding[];
  ml: MlPrediction | null;
  intelReporters: number;
  riskLevel: RiskLevel;
}): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const push = (r: string) => {
    if (!seen.has(r)) {
      seen.add(r);
      reasons.push(r);
    }
  };

  const ranked = [...opts.ruleSignals].sort((a, b) => b.weight - a.weight);
  for (const s of ranked) {
    if (s.ruleId.startsWith("combo.")) continue; // combos summarise members already listed
    push(s.description);
    if (reasons.length >= 5) break;
  }

  for (const u of opts.urls) {
    const top = u.flags.filter((f) => f.severity !== "low").slice(0, 2);
    for (const f of top) push(`Link ${u.hostname || u.url}: ${f.detail}.`);
    // Be explicit about what is NOT known: warning signs are not proof, and no record is not safety.
    if (top.length > 0 && u.reputation === "unknown" && !u.flags.some((f) => f.id === "intel.reputation")) {
      push(`Link ${u.hostname || u.url}: suspicious indicators detected; its reputation is unknown (not a confirmed scam site).`);
    }
    if (reasons.length >= 7) break;
  }

  if (opts.ml && opts.ml.riskScore >= 60 && opts.ml.category) {
    push(`Its wording closely resembles known ${CATEGORY_LABELS[opts.ml.category]} messages.`);
  }
  if (opts.intelReporters >= 2 && !reasons.some((r) => r.includes("ScamShield users"))) {
    push(`Matches a scam reported by ${opts.intelReporters} other ScamShield users.`);
  }
  if (reasons.length === 0) {
    push(opts.riskLevel === "safe" ? "No known scam indicators were found." : "The overall wording and context resemble scam messages.");
  }
  return reasons.slice(0, 8);
}

export function buildExplanation(riskLevel: RiskLevel, category: ScamCategory): string {
  const label = category !== "other" && riskLevel !== "safe" ? CATEGORY_LABELS[category] : "";
  return LEVEL_SENTENCE[riskLevel](label);
}

const CATEGORY_ACTIONS: Partial<Record<ScamCategory, string[]>> = {
  banking: ["Verify only through your bank's official app, website or the number printed on your card."],
  kyc: ["Banks never complete KYC through SMS/WhatsApp links. Visit your branch or use the official app."],
  upi: ["You never need to enter your UPI PIN or scan a QR code to RECEIVE money."],
  job: ["Genuine employers never charge registration or training fees. Do not pay to get a job."],
  investment: ["No legitimate investment guarantees returns. Check SEBI registration before investing."],
  lottery: ["You cannot win a lottery you never entered. Do not pay any 'processing fee'."],
  delivery: ["Track parcels only on the courier's official website or app using your tracking number."],
  loan: ["Use only RBI-registered lenders. Never pay an upfront fee for a loan."],
  government_impersonation: ["Police and government agencies do not demand money or 'digital arrest' over calls or chats. Hang up."],
  tech_support: ["Do not install remote-access apps (AnyDesk, TeamViewer) at a stranger's request."],
  romance: ["Never send money or gift cards to someone you have only met online."],
  malware: ["Do not install apps or open files from links; use the official app store only."],
  phishing: ["Type the official website address yourself instead of using links in messages."],
  credential_theft: ["Change your password and enable two-factor authentication if you already entered details."],
};

export function buildRecommendations(opts: {
  riskLevel: RiskLevel;
  category: ScamCategory;
  ruleSignals: RuleSignal[];
  hasUrls: boolean;
  llmActions: string[];
}): string[] {
  const out: string[] = [];
  const add = (a: string) => {
    const key = a.toLowerCase().replace(/[^a-z]/g, "").slice(0, 60);
    if (a && !out.some((o) => o.toLowerCase().replace(/[^a-z]/g, "").slice(0, 60) === key)) out.push(a);
  };
  const ids = new Set(opts.ruleSignals.map((s) => s.ruleId));

  if (opts.riskLevel === "safe") {
    add("No action needed. Never share OTPs, PINs or passwords, even with people who claim to be from your bank.");
    if (opts.hasUrls) add("If you open the link, check the website address carefully before entering any details.");
    return out;
  }

  if (opts.hasUrls) add("Do not click the link.");
  if ([...ids].some((i) => i.startsWith("cred.")) || ids.has("upi.pin_to_receive")) add("Do not share your OTP, PIN, CVV or passwords with anyone.");
  if ([...ids].some((i) => i.startsWith("pay.") || i === "job.fee_required")) add("Do not send any money or pay any fee.");
  if (ids.has("tech.remote_access")) add("Do not install AnyDesk, TeamViewer or any screen-sharing app.");
  for (const a of CATEGORY_ACTIONS[opts.category] ?? []) add(a);
  // AI-written advice is untrusted: drop anything carrying a link, domain, phone/account number,
  // e-mail or UPI handle (a manipulated model must not be able to send the user somewhere).
  for (const a of opts.llmActions.filter(isSafeAdviceText).slice(0, 3)) add(a);
  if (opts.riskLevel === "high" || opts.riskLevel === "critical") {
    add("Block the sender and report it. In India, report at cybercrime.gov.in or call 1930; you can also use Sanchar Saathi (Chakshu).");
    add("If you already shared details or paid, contact your bank immediately to freeze transactions.");
  } else {
    add("Verify the sender through an official channel before responding.");
  }
  return out.slice(0, 7);
}

const CONTACT_OR_LINK =
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|co|xyz|top|info|app|link|ly|me|biz|online|site|shop|example)\b|@|\d[\d\s-]{5,}\d/i;

/** True for short plain-language advice without links, domains, numbers or handles. */
export function isSafeAdviceText(a: string): boolean {
  return a.length > 0 && a.length <= 200 && !CONTACT_OR_LINK.test(a);
}
