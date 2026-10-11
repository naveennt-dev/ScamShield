import { describe, expect, it } from "vitest";
import { canonicalize, fingerprint, hammingDistance, simhash, simhashBands } from "@/lib/detection/fingerprint";
import { maskSensitiveText, redactForLog, safePreview } from "@/lib/observability/redact";

describe("content fingerprints", () => {
  it("collapses per-victim variations (amounts, OTPs, URL paths) to one fingerprint", () => {
    const a = "Dear customer, your OTP is 482913. Pay Rs 1,250 at https://pay-now.xyz/t/AbC123 today!";
    const b = "Dear  Customer, your OTP is 771204. Pay Rs 9,999 at https://pay-now.xyz/t/ZZ99 today!";
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(canonicalize(a)).not.toMatch(/482913|abc123/i);
  });

  it("near-duplicates have a small SimHash distance and share a band", () => {
    const base = "Your parcel is held at customs because the address is incomplete. Pay the redelivery fee within 12 hours at the link to release it.";
    const near = "Your parcel is held at customs because the address is incomplete. Pay the redelivery fee within 24 hours at this link to release it.";
    const other = "Hey, are we still on for dinner tonight? I booked a table at the usual place near the station.";
    const d = hammingDistance(simhash(base), simhash(near));
    expect(d).toBeLessThan(hammingDistance(simhash(base), simhash(other)));
    if (d <= 3) {
      const [x, y] = [simhashBands(simhash(base)), simhashBands(simhash(near))];
      expect(x.some((v, i) => v === y[i])).toBe(true);
    }
  });
});

describe("redaction", () => {
  it("masks OTPs, card numbers, emails, UPI IDs and API keys", () => {
    const s = maskSensitiveText("OTP 482913 card 4111 1111 1111 1111 mail john.doe@example.com upi ramesh@okaxis key sk-or-v1-abcdef1234567890");
    expect(s).not.toMatch(/482913|4111 1111|john\.doe|ramesh@|abcdef1234567890/);
    expect(s).toContain("####13");
  });

  it("removes sensitive keys from structured logs", () => {
    const r = redactForLog({ authorization: "Bearer x", nested: { otp: "1234", password: "p", ok: 1 }, list: [{ apiKey: "k" }] }) as Record<string, unknown>;
    expect(JSON.stringify(r)).not.toMatch(/Bearer x|1234|"p"|"k"/);
    expect((r.nested as Record<string, unknown>).ok).toBe(1);
  });

  it("produces bounded previews", () => {
    expect(safePreview("x ".repeat(1000), 50).length).toBeLessThanOrEqual(50);
  });
});
