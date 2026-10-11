// Isolated page-behaviour inspector (runs as its own process; see runner.ts).
// Input: one JSON argument. Output: lines "PARTIAL <json>" while running and "RESULT <json>" at the end.
// Never receives user cookies/accounts: a brand-new profile directory is created by the runner and
// deleted by it afterwards. Only synthetic data is ever typed. Nothing is submitted.
import { chromium } from "playwright-core";
import { parse as parseDomain } from "tldts";

const cfg = JSON.parse(process.argv[2]);
const t0 = Date.now();
const deadline = t0 + cfg.timeoutMs;
const left = () => Math.max(0, deadline - Date.now());
const site = (u) => {
  try {
    const h = new URL(u).hostname;
    return parseDomain(h).domain ?? h;
  } catch {
    return null;
  }
};
const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};

const out = {
  status: "partial",
  detail: null,
  durationMs: 0,
  observedWindowMs: 0,
  finalUrl: null,
  navigations: [],
  requests: { total: 0, thirdPartyHosts: [], blocked: [] },
  downloadsAttempted: [],
  permissionRequests: [],
  dialogs: [],
  popups: [],
  framesAfterScripts: [],
  formsAfterScripts: 0,
  passwordFieldsAfterScripts: 0,
  typedDataSentTo: [],
  passwordSentToSameSite: [],
  postsToThirdParties: [],
  domChangedByScripts: false,
};
const thirdParty = new Set();
const posts = new Set();
const exfil = new Set();
const pwSameSite = new Set();
const perms = new Set();
const emit = (tag) => {
  out.durationMs = Date.now() - t0;
  out.requests.thirdPartyHosts = [...thirdParty].slice(0, 40);
  out.postsToThirdParties = [...posts].slice(0, 20);
  out.typedDataSentTo = [...exfil];
  out.passwordSentToSameSite = [...pwSameSite];
  out.permissionRequests = [...perms];
  process.stdout.write(`${tag} ${JSON.stringify(out)}\n`);
};

// Synthetic canary values: unique per run and per field type, never real data. Text typed into
// ordinary boxes (search) is expected to reach the site's own servers (suggestions), so only the
// CREDENTIAL canaries (email, password) count — and only when they reach a DIFFERENT website.
const tag = () => Math.random().toString(36).slice(2, 10);
const canaries = { text: `ssq${tag()}`, email: `ssq${tag()}@example.invalid`, password: `Ss!${tag()}q` };
const encodings = (v) => [v, encodeURIComponent(v), Buffer.from(v).toString("base64").replace(/=+$/, "")];
const found = (s, kind) => typeof s === "string" && encodings(canaries[kind]).some((e) => s.includes(e));
function checkLeak(url, payload, viaHost) {
  const s = site(url);
  const host = viaHost ?? hostOf(url) ?? "unknown";
  for (const kind of ["email", "password"]) {
    if (!(found(url, kind) || found(payload, kind))) continue;
    if (s && pageSite && s !== pageSite) exfil.add(host);
    else if (kind === "password") pwSameSite.add(host);
  }
}

let ctx;
try {
  ctx = await chromium.launchPersistentContext(cfg.profileDir, {
    headless: true,
    chromiumSandbox: true, // Chromium's own process sandbox stays ON
    timeout: Math.min(15000, left()),
    acceptDownloads: false,
    permissions: [],
    serviceWorkers: "block",
    ignoreHTTPSErrors: false,
    bypassCSP: false,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    proxy: { server: `http://127.0.0.1:${cfg.proxyPort}`, bypass: "<-loopback>" },
    args: [
      "--proxy-bypass-list=<-loopback>",
      // Chromium resolves NO names itself: every destination is resolved and checked by the proxy.
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--dns-prefetch-disable",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-client-side-phishing-detection",
      "--disable-sync",
      "--disable-extensions",
      "--disable-default-apps",
      "--no-pings",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
      "--renderer-process-limit=4",
      "--js-flags=--max-old-space-size=256",
      "--disable-features=DnsOverHttps,AsyncDns,MediaRouter,DialMediaRouteProvider,OptimizationHints,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions",
    ],
  });
} catch (e) {
  out.status = "unavailable";
  out.detail = /Executable doesn't exist|browserType.launch/i.test(String(e?.message)) ? "The inspection browser (Chromium) isn't installed." : `The inspection browser could not start: ${String(e?.message).split("\n")[0].slice(0, 160)}`;
  emit("RESULT");
  process.exit(0);
}

await ctx.exposeBinding("__ssReport", (_src, kind, detail) => {
  if (kind === "permission") perms.add(String(detail).slice(0, 60));
});
await ctx.addInitScript(() => {
  const report = (d) => {
    try {
      window.__ssReport("permission", d);
    } catch {}
  };
  const deny = (name, obj, fn, result) => {
    if (!obj || typeof obj[fn] !== "function") return;
    obj[fn] = function () {
      report(name);
      return result();
    };
  };
  const rejected = () => Promise.reject(new DOMException("Denied by ScamShield inspector", "NotAllowedError"));
  deny("notifications", window.Notification, "requestPermission", () => Promise.resolve("denied"));
  deny("camera/microphone", navigator.mediaDevices, "getUserMedia", rejected);
  deny("screen capture", navigator.mediaDevices, "getDisplayMedia", rejected);
  deny("location", navigator.geolocation, "getCurrentPosition", () => undefined);
  deny("location", navigator.geolocation, "watchPosition", () => 0);
  deny("clipboard (read)", navigator.clipboard, "readText", rejected);
  deny("clipboard (read)", navigator.clipboard, "read", rejected);
  deny("clipboard (write)", navigator.clipboard, "writeText", rejected);
  deny("saved credentials", navigator.credentials, "get", rejected);
  deny("saved credentials", navigator.credentials, "create", rejected);
  deny("file access", window, "showOpenFilePicker", rejected);
  deny("USB/Bluetooth/serial devices", navigator.usb, "requestDevice", rejected);
  deny("USB/Bluetooth/serial devices", navigator.bluetooth, "requestDevice", rejected);
  deny("USB/Bluetooth/serial devices", navigator.serial, "requestPort", rejected);
  deny("push messages", window.PushManager?.prototype, "subscribe", rejected);
});

let pageSite = site(cfg.url);
let page = null;
ctx.on("request", (r) => {
  out.requests.total++;
  const u = r.url();
  const s = site(u);
  if (s && pageSite && s !== pageSite && !u.startsWith("data:")) thirdParty.add(hostOf(u));
  const body = r.postData();
  checkLeak(u, body);
  if (body && s && pageSite && s !== pageSite) posts.add(hostOf(u));
});
ctx.on("page", (p) => {
  if (page && p !== page) {
    out.popups.push(p.url().slice(0, 200));
    p.close().catch(() => {});
  }
});

page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("download", (d) => {
  out.downloadsAttempted.push(d.suggestedFilename().slice(0, 120));
  d.cancel().catch(() => {});
});
page.on("dialog", (d) => {
  out.dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`);
  d.dismiss().catch(() => {});
});
page.on("framenavigated", (f) => {
  if (f === page.mainFrame() && out.navigations.length < 20) out.navigations.push(f.url().slice(0, 300));
});
page.on("websocket", (ws) => {
  ws.on("framesent", (f) => {
    checkLeak(ws.url(), typeof f.payload === "string" ? f.payload : f.payload?.toString());
  });
});
page.on("filechooser", () => perms.add("file access"));

const domSummary = () =>
  page.evaluate(() => ({
    forms: document.forms.length,
    passwords: document.querySelectorAll("input[type=password]").length,
    frames: [...document.querySelectorAll("iframe,frame,embed")].map((f) => f.src || f.getAttribute("src") || "").filter(Boolean).slice(0, 20),
  }));

try {
  let raw = "";
  const resp = await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: Math.max(1000, left() - 2000) });
  try {
    raw = resp ? (await resp.text()).slice(0, 1_000_000) : "";
  } catch {}
  out.finalUrl = page.url();
  pageSite = site(out.finalUrl) ?? pageSite;
  emit("PARTIAL");
  const rawCounts = {
    forms: (raw.match(/<form\b/gi) ?? []).length,
    passwords: (raw.match(/type\s*=\s*["']?password/gi) ?? []).length,
    frames: (raw.match(/<(iframe|frame|embed)\b/gi) ?? []).length,
  };
  const observeStart = Date.now();
  await page.waitForTimeout(Math.min(cfg.observeMs, Math.max(0, left() - 3000)));

  // Type synthetic values into up to 3 visible fields — never submit, never press Enter.
  const fields = await page.$$("input[type=password], input[type=email], input[type=text], input[type=search], input[type=tel], input:not([type])");
  let typed = 0;
  for (const f of fields) {
    if (typed >= 3 || left() < 3000) break;
    try {
      if (!(await f.isVisible())) continue;
      const type = (await f.getAttribute("type")) ?? "text";
      await f.focus();
      const name = `${(await f.getAttribute("name")) ?? ""} ${(await f.getAttribute("autocomplete")) ?? ""}`.toLowerCase();
      const kind = type === "password" ? "password" : type === "email" || /email|user|login/.test(name) ? "email" : "text";
      await page.keyboard.type(canaries[kind], { delay: 15 });
      typed++;
    } catch {}
  }
  if (typed > 0) await page.waitForTimeout(Math.min(3000, Math.max(0, left() - 1500)));
  out.observedWindowMs = Date.now() - observeStart;

  const dom = await domSummary();
  out.framesAfterScripts = dom.frames;
  out.formsAfterScripts = dom.forms;
  out.passwordFieldsAfterScripts = dom.passwords;
  out.domChangedByScripts = dom.forms !== rawCounts.forms || dom.passwords !== rawCounts.passwords || dom.frames.length !== rawCounts.frames;
  out.finalUrl = page.url();
  out.status = "completed";
  out.detail = typed ? `Typed synthetic test data into ${typed} field(s) (never submitted).` : "No input fields to test.";
} catch (e) {
  const msg = String(e?.message ?? e);
  out.status = /Timeout/i.test(msg) ? "timeout" : "partial";
  out.detail = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NAME_NOT_RESOLVED|net::ERR/.test(msg)
    ? `The page could not be loaded in the isolated browser (${(/net::ERR_[A-Z_]+/.exec(msg) ?? ["network error"])[0]}).`
    : `Inspection stopped early: ${msg.split("\n")[0].slice(0, 160)}`;
} finally {
  try {
    await ctx.close();
  } catch {}
  emit("RESULT");
  process.exit(0);
}
