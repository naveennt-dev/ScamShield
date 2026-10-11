import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/detection/pipeline";
import { runScreenPipeline } from "@/lib/detection/screen";
import { asksReaderToAct, isAwarenessText } from "@/lib/detection/rules/context";
import { fuseRisk } from "@/lib/detection/risk-engine";

/**
 * Scam families added after the held-out evaluation (heldout-v2 / blind-v3). Examples here are
 * written separately from those sets; each family is tested with its scam AND a genuine look-alike.
 */

const analyse = async (text: string) =>
  (await runPipeline({ inputType: "message", text, requestId: "t", allowLlm: false }, { ai: null, intel: null })).result;
const ids = async (text: string) => (await analyse(text)).indicators.filter((i) => i.source === "rules").map((i) => i.type);

describe("new families fire on the scam", () => {
  it.each([
    ["person.new_number_money", "Hello aunty, it's Neha on a new number, my old phone broke. Could you transfer Rs 9,000 for my college fees today?"],
    ["person.new_number_money", "Bhaiya mera phone kho gaya, ye dost ka number hai. 5000 gpay kar do please"],
    ["person.secret_money_request", "Please send 12,000 to this account now and don't tell dad, I'll explain"],
    ["pay.gift_card_request", "I need you to purchase three Apple gift cards for a client today and email me the codes."],
    ["extortion.intimate_content", "I have the recording from our video chat. Pay 10000 or I will send it to your family and friends."],
    ["extortion.intimate_content", "Tumhari photos mere paas hai, 8000 bhejo warna instagram pe daal dunga"],
    ["pay.wrong_transfer_return", "Bhai galti se aapke account me 3000 chale gaye, please wapas kar do"],
    ["charity.direct_upi_donation", "Please donate for little Aarav's treatment, UPI: aarav.help@okaxis. Share widely"],
    ["shop.advance_payment_only", "Branded watches at 80% off. No COD, payment in advance only on UPI."],
    ["cred.wallet_seed_phrase", "Trust Wallet: to keep your funds, verify your 12-word seed phrase on our support form."],
    ["account.deletion_threat", "Your Facebook page will be permanently disabled today. Appeal here to keep it."],
    ["refund.bank_details_bait", "You are eligible for an electricity subsidy of Rs 3,000. Update your bank account details to receive it."],
    ["rewards.points_expiry", "Your 3,200 reward points expire today. Redeem now for cash."],
    ["account.mailbox_full", "Your email storage is full. Log in here to get free extra space."],
    ["tech.subscription_refund_call", "Your annual antivirus subscription was renewed for Rs 24,999. To cancel and get a refund call 9812345670."],
    ["tech.call_support_scare", "Warning! Your PC is infected with spyware. Call Windows support on 1-800-555-0100 now."],
    ["insurance.lapse_threat", "Your policy will lapse tonight. Pay the premium now on this link."],
    ["job.task_deposit", "Complete the merchant task: deposit Rs 3,000 to unlock your commission of Rs 7,500."],
    ["invest.private_group_tips", "Join our premium Telegram channel for daily 8% profit calls."],
    ["malware.enable_macros", "Invoice attached. Please enable macros to view the document."],
  ])("%s", async (rule, text) => {
    expect(await ids(text)).toContain(rule);
  });
});

describe("…and stay quiet on genuine look-alikes", () => {
  it.each([
    ["person.new_number_money", "Hi, this is my new number, please save it. See you at the party!"],
    ["pay.gift_card_request", "I bought you an Amazon gift card for your birthday, check your email!"],
    ["extortion.intimate_content", "Sending the wedding video to the family group now 🎉"],
    ["tech.subscription_refund_call", "Rs 2,000.00 debited from A/c XX1234 on 10-10-26. Not you? Call 1800 425 3800 - SBI"],
    ["account.deletion_threat", "Your account settings have been updated."],
    ["refund.bank_details_bait", "Your refund of Rs 499 has been credited to your original payment method."],
    ["malware.enable_macros", "Never enable macros in documents from unknown senders."],
    ["prize.winner_claim", "We bought a lottery ticket at the fair, results are next week"],
    ["utility.disconnection_threat", "Water supply will be cut on Sunday 9am-1pm for scheduled maintenance."],
  ])("%s not on: %s", async (rule, text) => {
    expect(await ids(text)).not.toContain(rule);
  });
});

describe("safety tips and news about scams", () => {
  it.each([
    "Banks never ask for your PIN or OTP. If someone does, report it at 1930.",
    "Police arrested three men who duped retirees with fake digital arrest calls.",
    "Savdhan: koi bhi bank OTP nahi maangta. Aisi call aaye to kaat dein.",
  ])("recognised as awareness: %s", (t) => {
    expect(isAwarenessText(t.toLowerCase())).toBe(true);
  });

  it("a scam that mentions fraudsters still addresses the reader and is not exempt", () => {
    expect(isAwarenessText("beware of fraudsters! your account is blocked, share the otp to unblock it now")).toBe(false);
  });

  it("a safety tip gets no rule warnings", async () => {
    const r = await analyse("RBI warns: banks never ask for your OTP, PIN or CVV. Never share them with anyone.");
    expect(r.riskLevel).toBe("safe");
  });
});

describe("nothing-asked gate (ML alone can't warn about a message that asks for nothing)", () => {
  it("detects an ask", () => {
    expect(asksReaderToAct("reply with the code to 9876543210")).toBe(true);
    expect(asksReaderToAct("vip access rs 4,999 only")).toBe(true);
    expect(asksReaderToAct("join us on telegram")).toBe(true);
    expect(asksReaderToAct("your emi of rs 3,200 is due on 05-11-2026. ensure sufficient balance.")).toBe(false);
    expect(asksReaderToAct("your whatsapp code: 482-019. don't share this code with others.")).toBe(false);
  });

  const base = {
    rules: { available: true, score: 0, confidence: 0.35, hasCriticalIndicator: false, promptInjectionDetected: false, signalCount: 0, categoryScores: {} },
    ml: { available: true, score: 95, confidence: 0.9, category: null, categoryProba: null, seedModel: false },
    url: null,
    llm: null,
  };

  it("caps an ML-only score below suspicious when nothing is asked, and says why", () => {
    const f = fuseRisk({ ...base, rules: { ...base.rules, asksReaderToAct: false } });
    expect(f.riskLevel).toBe("safe");
    expect(f.adjustments.some((a) => a.reason.includes("asks you to do nothing"))).toBe(true);
  });

  it("leaves an ML warning in place when the message asks for something", () => {
    expect(fuseRisk({ ...base, rules: { ...base.rules, asksReaderToAct: true } }).riskLevel).not.toBe("safe");
  });

  it("does not touch results with rule evidence", () => {
    const f = fuseRisk({ ...base, rules: { ...base.rules, score: 60, signalCount: 1, asksReaderToAct: false } });
    expect(f.riskLevel).not.toBe("safe");
  });
});

describe("decision explanation", () => {
  it("red result cites the threshold and the matched words", async () => {
    const r = await analyse("Your SBI account is blocked. Share the OTP sent to your phone to unblock it now.");
    expect(r.decision?.colour).toBe("red");
    expect(r.decision?.why).toMatch(/^Red: final score \d+\/100 is at or above the high-risk line/);
    expect(r.decision?.matches.some((m) => m.text.includes("otp"))).toBe(true);
    expect(r.decision?.basis.some((b) => b.startsWith("ML model:"))).toBe(true);
  });

  it("green result says what was checked and that it is not a guarantee when signs exist", async () => {
    const r = await analyse("Are we still on for lunch tomorrow at 1?");
    expect(r.decision?.colour).toBe("green");
    expect(r.decision?.why).toMatch(/^Green: final score \d+\/100 is below the suspicious line/);
    expect(r.decision?.basis[0]).toMatch(/^Safety rules: none/);
  });

  it("never contains unmasked long numbers", async () => {
    const r = await analyse("Your HDFC card 4111111111111111 is blocked, call 9876543210 and share the OTP 482913 now");
    expect(JSON.stringify(r.decision)).not.toMatch(/4111111111111111|9876543210|482913/);
  });
});

/**
 * Regression guard on the evaluation sets (synthetic, written for this project). The numbers are
 * the measured results at the time of writing; detection changes must not make them worse.
 */
describe("evaluation sets do not regress", () => {
  const run = async (file: string) => {
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { label: string; text: string });
    let caught = 0, flagged = 0;
    for (const r of rows) {
      const { result } = await runScreenPipeline({ inputType: "message", text: r.text, requestId: "e", allowLlm: false }, { ai: null, intel: null });
      if (result.riskLevel === "safe") continue;
      if (r.label === "scam") caught++;
      else flagged++;
    }
    return { caught, flagged };
  };
  it.each([
    ["tests/fixtures/eval/realistic-v1.jsonl", 28, 0],
    ["tests/fixtures/eval/heldout-v2.jsonl", 68, 5],
    ["tests/fixtures/eval/blind-v3.jsonl", 50, 1],
  ])("%s", async (file, minCaught, maxFlagged) => {
    const { caught, flagged } = await run(file);
    expect(caught).toBeGreaterThanOrEqual(minCaught);
    expect(flagged).toBeLessThanOrEqual(maxFlagged);
  }, 60_000);
});
