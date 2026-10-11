import { describe, expect, it } from "vitest";
import { analyzeUrlStatic } from "@/lib/url/analyzer";
import { extractUrls, normalizeUrl, refang } from "@/lib/url/extractor";

const flags = (u: string) => analyzeUrlStatic(u).flags.map((f) => f.id);

describe("URL extraction", () => {
  it("extracts explicit, www and bare URLs and strips trailing punctuation", () => {
    const urls = extractUrls("Visit https://a.example.com/x?y=1. Or www.b-example.com, or sbi-kyc.xyz/login!").map((u) => u.url);
    expect(urls).toEqual(["https://a.example.com/x?y=1", "http://www.b-example.com/", "http://sbi-kyc.xyz/login"]);
  });

  it("handles brackets and defanged URLs", () => {
    expect(refang("hxxps://evil[.]com/login")).toBe("https://evil.com/login");
    expect(extractUrls("(see evil[.]com)").map((u) => u.url)).toEqual(["http://evil.com/"]);
  });

  it("does not treat email addresses or file names as URLs", () => {
    expect(extractUrls("mail me at someone@example.com about report.pdf and notes.txt")).toEqual([]);
  });

  it("extracts bare IPv4 links with a path", () => {
    expect(extractUrls("go to 45.12.9.3/login now").map((u) => u.url)).toEqual(["http://45.12.9.3/login"]);
  });

  it("normalises hosts and removes fragments; rejects non-http schemes", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/a#frag")).toBe("https://example.com/a");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("caps the number of URLs", () => {
    const text = Array.from({ length: 40 }, (_, i) => `https://s${i}.example.com`).join(" ");
    expect(extractUrls(text)).toHaveLength(20);
  });
});

describe("URL static analysis", () => {
  it("scores official domains as low risk", () => {
    expect(analyzeUrlStatic("https://www.onlinesbi.sbi/").riskScore).toBe(0);
    expect(analyzeUrlStatic("https://www.amazon.in/orders").riskScore).toBe(0);
  });

  it("flags brand impersonation, suspicious TLDs and phishing paths", () => {
    const f = flags("http://sbi-kyc-update.xyz/login");
    expect(f).toEqual(expect.arrayContaining(["host.brand_impersonation", "host.suspicious_tld", "path.sensitive_keywords"]));
    expect(analyzeUrlStatic("http://sbi-kyc-update.xyz/login").riskScore).toBeGreaterThanOrEqual(60);
  });

  it("detects typosquats and IDN homographs", () => {
    expect(flags("https://paypa1.com/signin")).toContain("host.typosquat");
    expect(flags("https://xn--pypal-4ve.com/")).toContain("host.homograph");
  });

  it("flags IP hosts, obfuscated IPs and internal targets", () => {
    expect(flags("http://192.168.1.1/admin")).toEqual(expect.arrayContaining(["host.ip_literal", "host.internal_target"]));
    expect(flags("http://0x7f000001/")).toEqual(expect.arrayContaining(["host.obfuscated_ip", "host.internal_target"]));
    expect(flags("http://localhost:8080/")).toContain("host.internal_target");
  });

  it("flags shorteners, userinfo tricks, executables and dangerous schemes", () => {
    expect(flags("https://bit.ly/abc")).toContain("host.shortener");
    expect(flags("http://www.sbi.co.in@evil.example/login")).toContain("url.userinfo");
    expect(flags("https://files.example.com/update.apk")).toContain("path.executable");
    expect(flags("javascript:alert(document.cookie)")).toContain("scheme.dangerous");
  });

  it("uses reputation data when provided", () => {
    const f = analyzeUrlStatic("https://bad-domain.example/", [
      { domain: "bad-domain.example", maliciousConfidence: 0.7, source: "test", detail: "reported" },
    ]);
    expect(f.flags.map((x) => x.id)).toContain("intel.reputation");
  });
});

describe("link word warnings are specific (no blanket 'login/verify/KYC/refund' message)", () => {
  const detailOf = (u: string) => analyzeUrlStatic(u).flags.filter((f) => f.id === "path.sensitive_keywords").map((f) => f.detail);

  it.each([
    "https://github.com/login",
    "https://accounts.google.com/signin",
    "https://www.flipkart.com/account/orders?track=1",
    "https://bluedart.com/track-parcel",
    "https://news-site.com/update/payment-invoice",
    "https://myblog.com/how-to-claim-insurance",
    "https://unlockedgames.com/", // "unlock" only as part of another word
  ])("ordinary link is not flagged: %s", (u) => {
    expect(detailOf(u)).toEqual([]);
  });

  it("names the exact words and the kind of problem", () => {
    expect(detailOf("https://sbi-kyc-update.xyz/login")[0]).toBe('The website name contains "kyc" and the link\'s path "login" — it pretends to be a login / KYC / verification page');
    expect(detailOf("https://refund-claim-portal.top/form")[0]).toMatch(/"refund", "claim" — it uses prize \/ refund bait/);
    expect(detailOf("https://indiapost-redelivery.top/x")[0]).toMatch(/"redelivery" — it uses parcel-delivery bait/);
  });

  it("the old generic sentence is never produced", () => {
    for (const u of ["https://sbi-kyc-update.xyz/login", "https://bit.ly/claim-prize", "https://paypa1-secure-login.top/verify"]) {
      expect(detailOf(u).join(" ")).not.toMatch(/words like login\/verify\/KYC\/refund/);
    }
  });
});
