import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/detection/pipeline";
import { runScreenPipeline } from "@/lib/detection/screen";

/**
 * Corrective fix — rule gaps found with the realistic set (tests/fixtures/eval/realistic-v1.jsonl,
 * synthetic, written by the same author as the rules: a coverage/regression check, not an accuracy
 * claim). Each new rule is tested with its scam AND its genuine look-alike.
 */

const rules = async (text: string) =>
  (await runPipeline({ inputType: "message", text, requestId: "r", allowLlm: false }, { ai: null, intel: null })).result;
const ids = async (text: string) => (await rules(text)).indicators.filter((i) => i.source === "rules").map((i) => i.type);

describe("new rules fire on the scam…", () => {
  it.each([
    ["utility.disconnection_threat", "Dear consumer your electricity power will be disconnected tonight at 9.30pm. Contact our electricity officer 7894561230"],
    ["utility.disconnection_threat", "Aapka bijli bill pending hai, aaj raat light kaat di jayegi. Turant 9876543210 par call karein."],
    ["utility.disconnection_threat", "आज रात आपकी बिजली काट दी जाएगी। तुरंत इस नंबर पर कॉल करें।"],
    ["gov.fake_fine", "Your vehicle MH12AB1234 has a pending e-challan of Rs 2000. Pay now to avoid court action: echallan-parivahan.in.net/pay"],
    ["delivery.customs_threat", "FedEx: Your parcel containing illegal items has been seized by Mumbai customs. Press 1 to talk to the officer."],
    ["pay.emergency_money_request", "Hey it's Rahul, I'm stuck at the airport and my card isn't working. Can you send 8000 to my UPI rahul123@ybl?"],
    ["pay.emergency_money_request", "Hi Mum, I dropped my phone, this is my new number. Can you send me Rs 15,000 urgently?"],
    ["invest.crypto_doubling", "Elon Musk Bitcoin giveaway! Send 0.1 BTC and get 0.2 BTC back instantly."],
  ])("%s", async (rule, text) => {
    expect(await ids(text)).toContain(rule);
  });
});

describe("…and not on the genuine look-alike", () => {
  it.each([
    ["scheduled power maintenance", "Power supply will be disconnected today from 10 AM to 2 PM for scheduled maintenance work. Inconvenience is regretted."],
    ["news about the scam", "Police warn citizens about fake electricity bill messages that threaten disconnection and ask people to call a number."],
    ["friend asking for dinner money", "Can you send 500 to my UPI raj@ybl for last night's dinner? No hurry."],
    ["normal parcel update", "Delhivery: Your shipment AWB 1234567890 is out for delivery today. No payment is due."],
    ["crypto news", "Bitcoin prices rose 5% today as ETF inflows continued, analysts said."],
  ])("%s → no new-rule hit and not flagged", async (_n, text) => {
    const found = await ids(text);
    for (const r of ["utility.disconnection_threat", "gov.fake_fine", "gov.impersonation_threat", "delivery.customs_threat", "pay.emergency_money_request", "invest.crypto_doubling"]) {
      expect(found).not.toContain(r);
    }
    expect((await rules(text)).riskLevel).toBe("safe");
  });
});

it("official e-challan site: the new rules stay silent; the ML alone may say 'suspicious' (known limitation), never high", async () => {
  const text = "A traffic challan of Rs 500 is pending for vehicle MH12AB1234. Pay at echallan.parivahan.gov.in";
  expect(await ids(text)).not.toContain("gov.fake_fine");
  const r = await rules(text);
  expect(["safe", "suspicious"]).toContain(r.riskLevel);
  expect(r.indicators.filter((i) => i.source === "rules")).toHaveLength(0);
});

describe("realistic set (direct text through the screen path)", () => {
  const rows = readFileSync("tests/fixtures/eval/realistic-v1.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; label: string; text: string });
  it.each(rows.map((r) => [r.label, r.id, r] as const))("%s · %s", async (_l, _id, r) => {
    const { result } = await runScreenPipeline({ inputType: "message", text: r.text, requestId: "e", allowLlm: false }, { ai: null, intel: null });
    if (r.label === "scam") expect(result.riskLevel).not.toBe("safe");
    else expect(result.riskLevel).toBe("safe");
  });
});
