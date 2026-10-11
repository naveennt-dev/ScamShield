import { describe, expect, it } from "vitest";
import { createMlEngine } from "@/lib/detection/ml";
import { scanLink } from "@/lib/linkscan/scan";
import { analyzeUrlStatic } from "@/lib/url/analyzer";

/**
 * Brand look-alike tiers (examples separate from the evaluation sets). Strong evidence is high risk
 * on its own; brand + soft words is a warning; a brand name alone is not a warning.
 */
const ids = (u: string) => analyzeUrlStatic(u).flags.map((f) => `${f.id}:${f.severity}`);
const verdict = async (u: string) =>
  (await scanLink({ url: u, requestId: "t", networkAllowed: false, allowAi: false, inspectBehaviour: false }, { pipeline: { ai: null, intel: null, ml: createMlEngine({ service: null }) } })).verdict;

describe("strong look-alike evidence → high risk", () => {
  it.each([
    ["https://amaz0n.co/", "host.typosquat:high"],
    ["https://paypai-help.com/", "host.typosquat:high"],
    ["https://rnicrosoft-alerts.com/", "host.typosquat:high"],
    ["https://hdfcbank.com.verify-me.info/", "host.deceptive_subdomain:high"],
    ["https://amazon.in-orders.top/", "host.deceptive_subdomain:high"],
    ["https://xn--pple-43d.com/", "host.homograph:high"], // Cyrillic "а" in "apple"
    ["https://flipkart-account-locked.com/", "host.brand_impersonation:high"],
    ["https://netflix-billing-update.net/", "host.brand_impersonation:high"],
  ])("%s", async (u, flag) => {
    expect(ids(u)).toContain(flag);
    expect(await verdict(u)).toMatch(/high_risk|malicious/);
  });
});

describe("brand + softer words → a warning, not high risk", () => {
  it.each(["https://amazon-gift-deals.com/", "https://youtube-help-team.com/"])("%s", async (u) => {
    expect(ids(u)).toContain("host.brand_impersonation:medium");
    expect(await verdict(u)).toBe("suspicious");
  });
});

describe("benign look-alikes are not warned", () => {
  it.each([
    "https://www.amazon.in/gp/your-account", "https://smile.amazon.com/", "https://www.paypal.me/someone", "https://m.facebook.com/",
    "https://mail.google.com/", "https://www.icloud.com/photos", "https://lnkd.in/abc", "https://youtu.be/dQw4w9WgXcQ",
    "https://www.applestore-tips-blog.com/", "https://www.amazonia-travel.com/", "https://www.paypalfans.org/", "https://www.sbirestaurant.com/",
    "https://www.netflixandchill-recipes.com/", "https://theverge.com/microsoft-surface-review",
  ])("%s", async (u) => {
    expect(ids(u).some((f) => /:(high|medium)$/.test(f) && /brand|typosquat|homograph|deceptive/.test(f))).toBe(false);
    expect(await verdict(u)).toBe("no_known_threat");
  });
});

describe("no message model on a bare address", () => {
  it("is 'not applicable' — never a failed detector or a false 'Unable to assess'", async () => {
    const r = await scanLink({ url: "https://pay.google.com/", requestId: "t", networkAllowed: false, allowAi: false, inspectBehaviour: false }, { pipeline: { ai: null, intel: null, ml: createMlEngine({ service: null }) } });
    expect(r.verdict).toBe("no_known_threat");
    expect(r.coverage.find((c) => c.id === "ml")?.status).toBe("not_applicable");
    expect(r.analysis?.assessment.status).toBe("complete");
  });
});
