import { describe, expect, it } from "vitest";
import { preprocess } from "@/lib/detection/preprocess";
import { runRules } from "@/lib/detection/rule-engine";
import { RULES } from "@/lib/detection/rules";

const ids = (t: string) => runRules(preprocess(t)).signals.map((s) => s.ruleId);

describe("rule modules", () => {
  it("every rule is unique, weighted 0–1 and explained", () => {
    const seen = new Set<string>();
    for (const r of RULES) {
      expect(seen.has(r.id)).toBe(false);
      seen.add(r.id);
      expect(r.weight).toBeGreaterThan(0);
      expect(r.weight).toBeLessThan(1);
      expect(r.description.length).toBeGreaterThan(10);
    }
    expect(RULES.length).toBeGreaterThanOrEqual(36);
  });

  it("produces structured signals (ruleId, category, severity, evidence, weight)", () => {
    const s = runRules(preprocess("Share the OTP with our executive now")).signals[0];
    expect(s).toMatchObject({ ruleId: "cred.otp_request", category: "credential_theft", severity: "high", weight: 0.55 });
    expect(s.evidence).toContain("otp");
  });
});

describe("Hinglish", () => {
  it.each([
    ["OTP request", "Aapka account block ho jayega. OTP batao jo abhi aaya hai.", "cred.otp_request"],
    ["OTP request (verb first)", "Jaldi se apna OTP bhej do", "cred.otp_request"],
    ["account threat", "Dear customer aapka bank account block ho jayega", "bank.account_threat"],
    ["UPI PIN to receive", "Aapko 5000 ka refund mila hai, receive karne ke liye UPI PIN daaliye.", "upi.pin_to_receive"],
    ["lottery", "Aapne 25 lakh ki lottery jeeti hai", "prize.winner_claim"],
    ["job", "Ghar baithe 3000 roz kamaiye, registration fee 500 rupaye", "job.fee_required"],
    ["investment", "Paisa double karo 30 din mein", "invest.guaranteed_returns"],
    ["remote access", "AnyDesk install karo aur code share karo", "tech.remote_access"],
    ["secrecy", "Kisi ko mat batana, aap digital arrest mein ho", "tactic.secrecy"],
    ["loan", "Instant loan bina CIBIL ke, sirf processing fee do", "loan.instant_offer"],
    ["KYC urgency", "Apka KYC expire ho gya hai, abhi verify kro", "kyc.urgent_update"],
  ])("%s", (_n, text, rule) => {
    expect(ids(text)).toContain(rule);
  });

  it("does not flag safety advice or normal chat", () => {
    expect(ids("Apka OTP 4821 hai, ise kisi ke saath share na karein.")).not.toContain("cred.otp_request");
    expect(ids("OTP kisi ko mat batao, bank kabhi OTP nahi maangta")).not.toContain("cred.otp_request");
    expect(ids("Bhai kal match dekhne chalein? 7 baje milte hain.")).toEqual([]);
    expect(ids("Main abhi aa raha hoon, khana ready rakhna")).toEqual([]);
  });
});

describe("Hindi (Devanagari)", () => {
  it.each([
    ["OTP request", "आपके फोन पर आया ओटीपी तुरंत बताइए", "cred.otp_request"],
    ["KYC urgency", "प्रिय ग्राहक, आपका केवाईसी समाप्त हो गया है। तुरंत अपडेट करें", "kyc.urgent_update"],
    ["account threat", "आपका खाता बंद कर दिया जाएगा", "bank.account_threat"],
    ["lottery", "बधाई हो! आपने 25 लाख रुपये की लॉटरी जीती है", "prize.winner_claim"],
    ["job fee", "घर बैठे रोज़ 3000 रुपये कमाएं। रजिस्ट्रेशन फीस केवल 500 रुपये।", "job.easy_money_tasks"],
    ["government", "यह मुंबई पुलिस है। आपके आधार पर मनी लॉन्ड्रिंग का केस दर्ज है।", "gov.impersonation_threat"],
    ["secrecy", "किसी को न बताएं", "tactic.secrecy"],
    ["urgency", "तुरंत भुगतान करें", "tactic.urgency"],
  ])("%s", (_n, text, rule) => {
    expect(ids(text)).toContain(rule);
  });

  it("does not flag genuine Hindi notifications", () => {
    expect(ids("आपका ओटीपी 482913 है। इसे किसी के साथ साझा न करें। बैंक कभी ओटीपी नहीं मांगता।")).not.toContain("cred.otp_request");
    expect(ids("आपके खाते में ₹15,000 जमा किए गए हैं।")).toEqual([]);
    expect(ids("कल शाम को मिलते हैं, मैं सात बजे तक पहुँच जाऊँगा।")).toEqual([]);
  });

  it("the Devanagari danda ends a sentence for proximity rules", () => {
    expect(ids("ओटीपी आपके फोन पर भेजा गया है। कृपया हमें अपना पता बताइए")).not.toContain("cred.otp_request");
  });
});

describe("combined indicators and false-positive guards (English)", () => {
  it("OTP + PIN + urgent bank impersonation stacks to critical-level rule evidence", () => {
    const r = runRules(preprocess("URGENT: SBI account will be blocked today. Share the OTP and enter your UPI PIN at http://sbi-verify.top"));
    expect(r.hasCriticalIndicator).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.signals.map((s) => s.ruleId)).toEqual(expect.arrayContaining(["cred.otp_request", "cred.pin_request", "bank.account_threat", "combo.credential_request_with_link"]));
  });

  it("UPI handles are not brand claims", () => {
    expect(ids("Rs 240 paid to zomato@icici. Call 1800 103 1906 for help.")).not.toContain("bank.impersonation_cta");
  });

  it.each([
    "Your KYC has been successfully updated.",
    "Interview scheduled for Monday, please confirm your availability.",
    "Mutual fund investments are subject to market risks.",
    "Your parcel was delivered. Rate your experience in the app.",
  ])("genuine message has no high-severity signals: %s", (t) => {
    expect(runRules(preprocess(t)).signals.filter((s) => s.severity === "high")).toEqual([]);
  });
});
