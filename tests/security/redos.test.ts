import { describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/detection/pipeline";

/** Regression guard: regexes run over untrusted text must stay (near-)linear at max input size. */
const N = 10_000;
const ADVERSARIAL: Record<string, string> = {
  hyphens: "a-".repeat(N / 2),
  dots: "a.".repeat(N / 2),
  emailish: "a@" + "a.".repeat(N / 2 - 2) + "!",
  at: "a@".repeat(N / 2),
  digits: "1".repeat(N),
  money: "rs " + "1,".repeat(N / 2 - 3),
  zeroWidth: "a​".repeat(N / 2),
  repeatedVerbs: "share otp send pay ".repeat(N / 19),
  domainish: "x-y.".repeat(N / 4),
};

describe("ReDoS resistance", () => {
  it.each(Object.entries(ADVERSARIAL))("%s input (10k chars) analyses in < 1.5 s", async (_name, text) => {
    const t = performance.now();
    await runPipeline({ inputType: "message", text: text.slice(0, N), requestId: "redos", allowLlm: false }, { ai: null, intel: null });
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
