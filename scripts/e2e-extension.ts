/**
 * End-to-end test of the ScamShield Link Guard extension in Playwright's Chromium against the REAL
 * local ScamShield service (scripts/scamshield.sh start; ALLOW_BROWSER_EXTENSION=true). Test pages
 * are served locally; look-alike hostnames are mapped to them with Chromium's resolver rules, so no
 * real phishing site is contacted. Run: npx tsx scripts/e2e-extension.ts
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const EXT = path.resolve("extension/chromium");
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

async function main() {
  const server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>${req.headers.host}</title></head><body><h1>${req.headers.host}</h1></body></html>`));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const dir = mkdtempSync(path.join(os.tmpdir(), "scamshield-ext-e2e-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP paypa1-secure-login.top 127.0.0.1:${port}, MAP calm-cooking-notes.com 127.0.0.1:${port}, EXCLUDE 127.0.0.1`,
    ],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    const extId = new URL(sw.url()).host;
    check("extension loaded", /^[a-p]{32}$/.test(extId), extId);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // A freshly installed extension's service worker needs a moment before it sees navigations
    // (documented limitation: navigations during extension start-up are not checked).
    await page.waitForTimeout(1000);

    await page.goto(`http://calm-cooking-notes.com/recipes`).catch(() => {});
    await page.waitForTimeout(2500);
    const stored = JSON.stringify(await sw.evaluate(() => (globalThis as unknown as { chrome: { storage: { session: { get(k: null): Promise<unknown> } } } }).chrome.storage.session.get(null)));
    // The only plain URL kept is the tab's safe return point; verdict cache entries carry no site name.
    check("verdict cache holds no site names for allowed pages", !stored.replace(/"safe:\d+":"[^"]*"/g, "").includes("calm-cooking-notes"), stored.slice(0, 160));
    check("ordinary site is not interrupted", page.url().startsWith("http://calm-cooking-notes.com/"), page.url());

    await page.goto(`http://paypa1-secure-login.top/verify?token=SECRET`).catch(() => {});
    await page.waitForURL(/warning\.html/, { timeout: 8000 }).catch(() => {});
    const warned = page.url().startsWith(`chrome-extension://${extId}/warning.html`);
    check("look-alike phishing address → warning page", warned, page.url().split("#")[0]);
    if (warned) {
      const title = await page.textContent("#title");
      check("warning shows the verdict", /High risk|Malicious/.test(title ?? ""), title ?? "");
      check("warning shows the site", (await page.textContent("#host")) === "paypa1-secure-login.top");
      await page.click("#back");
      await page.waitForTimeout(1500);
      check("'Go back to safety' returns to the last safe page", page.url() === "http://calm-cooking-notes.com/recipes", page.url().split("#")[0]);
      await page.goto(`http://paypa1-secure-login.top/verify`).catch(() => {});
      await page.waitForURL(/warning\.html/, { timeout: 8000 }).catch(() => {});
      await page.click("summary");
      await page.click("#continue");
      await page.waitForURL(/paypa1-secure-login\.top/, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      check("'Continue anyway' opens that site for this session only", page.url().startsWith("http://paypa1-secure-login.top/"), page.url());
    }
  } finally {
    await ctx.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  for (const [n, ok, d] of results) console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? `  [${d}]` : ""}`);
  process.exitCode = results.every((r) => r[1]) ? 0 : 1;
}
void main();
