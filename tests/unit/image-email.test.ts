import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessAttachment, analyzeEmailMetadata, parseAddress } from "@/lib/email/analyzer";
import { ImageValidationError, validateImage } from "@/lib/ocr/image-validation";

const png = new Uint8Array(readFileSync("tests/fixtures/scam.png"));
const jpg = new Uint8Array(readFileSync("tests/fixtures/scam.jpg"));
const webp = new Uint8Array(readFileSync("tests/fixtures/scam.webp"));

function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

describe("image validation", () => {
  it("sniffs real PNG/JPEG/WebP files and reads dimensions", () => {
    expect(validateImage(png, "a.png")).toMatchObject({ kind: "png", width: 900, height: 220 });
    expect(validateImage(jpg, "a.jpeg")).toMatchObject({ kind: "jpeg", width: 900, height: 220 });
    expect(validateImage(webp, "a.webp")).toMatchObject({ kind: "webp", width: 900, height: 220 });
  });

  it("ignores claimed type: a text/HTML/SVG file named .png is rejected", () => {
    for (const fake of ["<svg onload=alert(1)>", "<html><script>x</script>", "MZ\x90\x00 executable"]) {
      expect(() => validateImage(new TextEncoder().encode(fake), "photo.png")).toThrowError(ImageValidationError);
    }
  });

  it("rejects extension/content mismatches", () => {
    expect(() => validateImage(png, "image.jpg")).toThrowError(expect.objectContaining({ reason: "extension_mismatch" }));
    expect(() => validateImage(png, "image.png.exe")).toThrowError(expect.objectContaining({ reason: "extension_mismatch" }));
  });

  it("rejects decompression bombs and tiny images by header dimensions", () => {
    expect(() => validateImage(pngHeader(50_000, 50_000), "x.png")).toThrowError(expect.objectContaining({ reason: "dimensions_too_large" }));
    expect(() => validateImage(pngHeader(9000, 9000), "x.png")).toThrowError(expect.objectContaining({ reason: "dimensions_too_large" }));
    expect(() => validateImage(pngHeader(4, 4), "x.png")).toThrowError(expect.objectContaining({ reason: "dimensions_too_small" }));
    expect(() => validateImage(new Uint8Array(), "x.png")).toThrowError(expect.objectContaining({ reason: "empty" }));
  });
});

describe("email analysis (metadata only)", () => {
  it("parses addresses", () => {
    expect(parseAddress('"SBI Alerts" <alerts@sbi-secure.xyz>')).toEqual({ displayName: "SBI Alerts", address: "alerts@sbi-secure.xyz", domain: "sbi-secure.xyz" });
    expect(parseAddress("someone@mail.example.co.uk").domain).toBe("example.co.uk");
  });

  it("flags brand display-name spoofing, free-mail authority, reply-to mismatch and DMARC failure", () => {
    const r = analyzeEmailMetadata({
      from: '"SBI Bank" <sbi.alerts@gmail.com>',
      replyTo: "refunds@other-domain.top",
      subject: "Account blocked",
      body: "",
      authenticationResults: "spf=softfail; dkim=fail; dmarc=fail",
      attachments: [],
    });
    expect(r.signals.map((s) => s.ruleId)).toEqual(expect.arrayContaining(["email.freemail_brand", "email.reply_to_mismatch", "email.dmarc_fail"]));
  });

  it("does not flag an official sender", () => {
    const r = analyzeEmailMetadata({ from: "HDFC Bank <alerts@hdfcbank.com>", subject: "Statement", body: "Your statement is ready", attachments: [] });
    expect(r.signals).toEqual([]);
  });

  it("assesses attachments by name only", () => {
    expect(assessAttachment({ filename: "invoice.pdf.exe" }).risk).toBe("high");
    expect(assessAttachment({ filename: "update.apk" }).risk).toBe("high");
    expect(assessAttachment({ filename: "salary.xlsm" }).risk).toBe("medium");
    expect(assessAttachment({ filename: "login.html" }).risk).toBe("medium");
    expect(assessAttachment({ filename: "invoice‮fdp.exe" }).risk).toBe("high");
    expect(assessAttachment({ filename: "report.pdf", contentType: "application/pdf" }).risk).toBe("low");
  });
});
