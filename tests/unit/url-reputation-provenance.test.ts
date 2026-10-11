import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeUrls, clearReputationCache } from "@/lib/url/service";
import type { DomainReputationProvider } from "@/lib/url/types";

/** URL intelligence: structured provenance, "not checked" vs "no record", caching. */

const provider = (impl: DomainReputationProvider["lookup"], available = true): DomainReputationProvider & { lookup: ReturnType<typeof vi.fn> } => ({
  name: "test-feed",
  isAvailable: () => available,
  lookup: vi.fn(impl),
});

beforeEach(() => clearReputationCache());

describe("URL intelligence result", () => {
  it("a known malicious domain carries source, evidence, confidence and lastUpdated", async () => {
    const p = provider(async () => [
      { domain: "evil-kyc.top", maliciousConfidence: 0.9, source: "test-feed", status: "confirmed_malicious", detail: "On a verified phishing list", lastUpdated: "2026-10-01T00:00:00.000Z" },
    ]);
    const [f] = await analyzeUrls(["https://login.evil-kyc.top/a"], { reputationProviders: [p] });
    expect(f.reputation).toBe("confirmed_malicious");
    expect(f.registrableDomain).toBe("evil-kyc.top");
    expect(f.intel).toEqual({
      checked: true,
      checkedBy: ["test-feed"],
      sources: ["test-feed"],
      evidence: ["On a verified phishing list"],
      confidence: 0.9,
      lastUpdated: "2026-10-01T00:00:00.000Z",
    });
  });

  it("checked with no record: unknown, checked=true, no confidence", async () => {
    const [f] = await analyzeUrls(["https://example-shop.in/x"], { reputationProviders: [provider(async () => [])] });
    expect(f.reputation).toBe("unknown");
    expect(f.intel?.checked).toBe(true);
    expect(f.intel?.confidence).toBeNull();
  });

  it("provider failure: unknown with checked=false (never presented as clean)", async () => {
    const [f] = await analyzeUrls(["https://example-shop.in/x"], { reputationProviders: [provider(async () => { throw new Error("db down"); })] });
    expect(f.reputation).toBe("unknown");
    expect(f.intel?.checked).toBe(false);
  });

  it("unavailable provider is not consulted", async () => {
    const p = provider(async () => [], false);
    const [f] = await analyzeUrls(["https://example-shop.in/x"], { reputationProviders: [p] });
    expect(p.lookup).not.toHaveBeenCalled();
    expect(f.intel?.checked).toBe(false);
  });

  it("no providers: nothing is claimed", async () => {
    const [f] = await analyzeUrls(["https://example-shop.in/x"]);
    expect(f.intel).toMatchObject({ checked: false, sources: [], evidence: [] });
  });

  it("repeat lookups are served from the cache", async () => {
    const p = provider(async () => [{ domain: "evil-kyc.top", maliciousConfidence: 0.4, source: "test-feed", status: "suspicious", detail: "Reported by users" }]);
    await analyzeUrls(["https://evil-kyc.top/1"], { reputationProviders: [p] });
    const [again] = await analyzeUrls(["https://evil-kyc.top/2"], { reputationProviders: [p] });
    expect(p.lookup).toHaveBeenCalledTimes(1);
    expect(again.reputation).toBe("suspicious");
  });

  it("benign reports never become a risk signal", async () => {
    const p = provider(async () => [{ domain: "mybank.co.in", maliciousConfidence: 0, source: "test-feed", status: "benign_reports", detail: "Reported as legitimate" }]);
    const [f] = await analyzeUrls(["https://mybank.co.in/"], { reputationProviders: [p] });
    expect(f.reputation).toBe("benign_reports");
    expect(f.flags.some((x) => x.id === "intel.reputation")).toBe(false);
  });
});
