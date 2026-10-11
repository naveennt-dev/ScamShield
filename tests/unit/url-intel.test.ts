import { describe, expect, it } from "vitest";
import { normalizeDomainKey, prepareIntelRecord, IntelValidationError, urlFingerprint } from "@/lib/intel/records";
import { runPipeline } from "@/lib/detection/pipeline";
import { analyzeUrlStatic } from "@/lib/url/analyzer";
import { extractUrls } from "@/lib/url/extractor";
import { assertSafeUrl, isBlockedIp, UnsafeUrlError, type Resolver } from "@/lib/url/safety";
import { parseIntelFile } from "../../scripts/intel-import";

/** Phase 5 — URL intelligence (pure / no network). */

const ids = (u: string) => analyzeUrlStatic(u).flags.map((f) => f.id);
const resolver = (map: Record<string, string[]>): Resolver => async (h) => map[h] ?? ["93.184.216.34"];

describe("URL intelligence: domains", () => {
  it("trusted official domain → no brand/look-alike flags, reputation unknown", () => {
    const f = analyzeUrlStatic("https://www.onlinesbi.sbi/personal/login");
    expect(f.flags.map((x) => x.id)).not.toContain("host.brand_impersonation");
    expect(f.flags.some((x) => x.id.startsWith("host.homograph") || x.id === "host.brand_impersonation")).toBe(false);
    expect(f.reputation).toBe("unknown");
    expect(f.riskScore).toBeLessThan(30);
  });

  it("look-alike brand domain is flagged and is not the official registrable domain", () => {
    const f = analyzeUrlStatic("http://sbi-kyc-update.xyz/login");
    expect(f.registrableDomain).toBe("sbi-kyc-update.xyz");
    expect(f.flags.some((x) => x.id === "host.brand_impersonation")).toBe(true);
    expect(f.riskScore).toBeGreaterThanOrEqual(40);
  });

  it("brand in a misleading subdomain belongs to the attacker's registrable domain", () => {
    for (const u of ["https://www.sbi.co.in.secure-login.attacker.test/kyc", "https://trusted.example.attacker.test/"]) {
      const f = analyzeUrlStatic(u);
      expect(f.registrableDomain).toBe("attacker.test");
      expect(normalizeDomainKey(u)).toBe("attacker.test");
    }
    expect(analyzeUrlStatic("https://www.sbi.co.in.secure-login.attacker.test/kyc").flags.some((x) => x.id === "host.brand_impersonation")).toBe(true);
  });

  it("Unicode homograph and punycode", () => {
    const cyr = analyzeUrlStatic("https://pаypal.com/signin"); // Cyrillic "а"
    expect(cyr.hostname.startsWith("xn--")).toBe(true);
    expect(cyr.flags.map((x) => x.id)).toEqual(expect.arrayContaining(["host.punycode"]));
    expect(cyr.flags.some((x) => x.id === "host.homograph")).toBe(true);
    expect(normalizeDomainKey("münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(normalizeDomainKey("xn--mnchen-3ya.de")).toBe("xn--mnchen-3ya.de");
  });

  it("shortened URL is a warning sign, not proof of fraud", () => {
    const f = analyzeUrlStatic("https://bit.ly/3xYz12");
    expect(ids("https://bit.ly/3xYz12")).toContain("host.shortener");
    expect(f.riskScore).toBeLessThan(60);
  });

  it("IP-address hosts, including obfuscated encodings", () => {
    expect(ids("http://45.12.9.3/login")).toContain("host.ip_literal");
    expect(ids("http://3232235777/")).toEqual(expect.arrayContaining(["host.ip_literal", "host.internal_target"])); // 192.168.1.1
    expect(ids("http://0xc0a80101/")).toContain("host.internal_target");
  });

  it("user-info trick shows the real host", () => {
    const f = analyzeUrlStatic("https://www.sbi.co.in@evil.example/login");
    expect(f.hostname).toBe("evil.example");
    expect(f.flags.map((x) => x.id)).toContain("url.userinfo");
  });

  it("private/internal and IPv6 edge cases", () => {
    expect(ids("http://192.168.1.10/admin")).toContain("host.internal_target");
    expect(ids("http://[::1]:8080/")).toContain("host.internal_target");
    expect(ids("http://[fd00:ec2::254]/latest/meta-data")).toContain("host.internal_target");
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("malformed and very long URLs are handled safely and quickly", () => {
    expect(ids("http://[::1")).toContain("url.unparsable");
    const long = `https://example.com/${"a".repeat(20000)}`;
    const t = Date.now();
    const f = analyzeUrlStatic(long);
    expect(Date.now() - t).toBeLessThan(200);
    expect(f.url.length).toBeLessThanOrEqual(500);
    expect(normalizeDomainKey("x".repeat(3000))).toBeNull();
    expect(normalizeDomainKey("javascript:alert(1)")).toBeNull();
    expect(urlFingerprint("javascript:alert(1)")).toBeNull();
  });

  it("plain HTTP alone is a low-severity signal", () => {
    const f = analyzeUrlStatic("http://example.com/menu");
    expect(f.flags.find((x) => x.id === "scheme.no_tls")?.severity).toBe("low");
    expect(f.riskScore).toBeLessThan(30);
  });

  it("unusual port is flagged", () => {
    expect(ids("https://shop.example.com:8443/pay")).toContain("url.nonstandard_port");
  });
});

describe("URL intelligence: extraction", () => {
  it("finds links in punctuation, www., bare domains; marks obfuscated forms", () => {
    const urls = extractUrls("Visit (https://a.example/x), www.b-example.com. Or c-example.org/login! Also d-example[.]com/kyc and hxxps://e-example.net/p");
    const byHost = Object.fromEntries(urls.map((u) => [new URL(u.url).hostname, u]));
    expect(Object.keys(byHost)).toEqual(expect.arrayContaining(["a.example", "www.b-example.com", "c-example.org", "d-example.com", "e-example.net"]));
    expect(byHost["d-example.com"].obfuscated).toBe(true);
    expect(byHost["e-example.net"].obfuscated).toBe(true);
    expect(byHost["a.example"].obfuscated ?? false).toBe(false);
  });

  it("obfuscated link raises a visible flag and reasons say reputation is unknown", async () => {
    const { result } = await runPipeline(
      { inputType: "message", text: "Your parcel is on hold. Pay the fee at indiapost-redelivery[.]top/pay today.", requestId: "t", allowLlm: false },
      { ai: null, intel: null },
    );
    const link = result.urls.find((u) => u.hostname === "indiapost-redelivery.top")!;
    expect(link.flags.map((f) => f.id)).toContain("url.obfuscated");
    expect(link.reputation).toBe("unknown");
    expect(result.reasons.join(" ")).toMatch(/reputation is unknown/);
    // Only ever phrased as "not a confirmed scam site".
    expect(result.reasons.join(" ").replace(/not a confirmed scam site/g, "")).not.toMatch(/confirmed/i);
  });
});

describe("SSRF: alternate encodings and internal destinations", () => {
  it.each(["http://0x7f.1/", "http://2130706433/", "http://017700000001/", "http://[::ffff:7f00:1]/", "http://metadata.google.internal/", "http://localhost./", "http://[fe80::1]/"])(
    "%s is refused",
    async (u) => {
      await expect(assertSafeUrl(u, resolver({}))).rejects.toBeInstanceOf(UnsafeUrlError);
    },
  );

  it("a public name that resolves to a private address (DNS rebinding) is refused", async () => {
    await expect(assertSafeUrl("http://rebind.attacker.test/", resolver({ "rebind.attacker.test": ["93.184.216.34", "10.0.0.5"] }))).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("a public destination is allowed", async () => {
    await expect(assertSafeUrl("https://example.com/", resolver({ "example.com": ["93.184.216.34"] }))).resolves.toBeTruthy();
  });
});

describe("intelligence record validation (no DB)", () => {
  const base = { kind: "DOMAIN", value: "evil-example.top", sourceType: "IMPORTED_PUBLIC", status: "SUSPICIOUS", confidence: 0.6, sourceName: "import:test.csv", updateMethod: "import" };

  it("normalises the key to the registrable domain", () => {
    expect(prepareIntelRecord({ ...base, value: "HTTPS://Login.SBI.co.in.Evil-Example.TOP./x?token=abc" }).key).toBe("evil-example.top");
  });

  it("USER_REPORT / LOCAL_RULE can never be CONFIRMED_MALICIOUS; confidence is capped", () => {
    for (const sourceType of ["USER_REPORT", "LOCAL_RULE"]) {
      const r = prepareIntelRecord({ ...base, sourceType, status: "CONFIRMED_MALICIOUS", confidence: 1, updateMethod: "report", sourceName: "user-report" });
      expect(r.status).toBe("SUSPICIOUS");
      expect(r.confidence).toBe(0.5);
      expect(r.notes.join(" ")).toMatch(/cannot confirm/);
    }
    expect(prepareIntelRecord({ ...base, sourceType: "VERIFIED", status: "CONFIRMED_MALICIOUS", confidence: 0.9, updateMethod: "manual-review", sourceName: "manual-review" }).status).toBe("CONFIRMED_MALICIOUS");
  });

  it("there is no LLM source type", () => {
    expect(() => prepareIntelRecord({ ...base, sourceType: "LLM" })).toThrow(IntelValidationError);
  });

  it.each([
    [{ value: "192.168.1.1" }],
    [{ value: "not a domain" }],
    [{ value: "evil.test'; DROP TABLE scam_intel;--" }],
    [{ kind: "URL", value: "javascript:alert(1)" }],
    [{ status: "MAYBE" }],
    [{ confidence: 2 }],
    [{ category: "made_up" }],
    [{ sourceName: "x'; DROP TABLE users;--" }],
    [{ expiresAt: "2001-01-01" }],
    [{ extra: "field" }],
  ])("rejects invalid input %o", (patch) => {
    expect(() => prepareIntelRecord({ ...base, ...patch })).toThrow(IntelValidationError);
  });

  it("URL records store only a hash of the URL without query/fragment", () => {
    const a = prepareIntelRecord({ ...base, kind: "URL", value: "https://evil-example.top/login?session=SECRET123#x" });
    const b = prepareIntelRecord({ ...base, kind: "URL", value: "https://EVIL-EXAMPLE.top/login/" });
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(a.key).toBe(b.key);
    expect(JSON.stringify(a)).not.toContain("SECRET123");
  });

  it("explanations are masked (no OTPs, numbers, emails)", () => {
    const r = prepareIntelRecord({ ...base, explanation: "victim ravi@example.com sent OTP 482913 to +91 98765 43210" });
    expect(r.explanation).not.toMatch(/482913|98765|ravi@/);
  });

  it("import parser handles quoted CSV and rejects unknown columns", () => {
    const rows = parseIntelFile("x.csv", 'kind,value,status,category,confidence,explanation\nDOMAIN,evil-example.top,SUSPICIOUS,kyc,0.6,"KYC, phishing ""campaign"""\n');
    expect(rows).toEqual([{ kind: "DOMAIN", value: "evil-example.top", status: "SUSPICIOUS", category: "kyc", confidence: 0.6, explanation: 'KYC, phishing "campaign"' }]);
    expect(() => parseIntelFile("x.csv", "kind,value,password\n")).toThrow(/Unknown CSV columns/);
  });
});
