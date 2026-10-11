import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import type { DynamicSummary } from "@/lib/schemas/link";
import type { Resolver } from "@/lib/url/safety";
import { startInspectionProxy, type ProxyOptions } from "./proxy";

/**
 * Second-stage, explicitly requested page-behaviour inspection.
 *
 * Per inspection: a new SSRF-filtering proxy (secret per run) → a NEW Chromium process in a NEW
 * empty profile directory, launched by a separate worker process that gets no secrets (minimal
 * environment), CPU-time and file-size limits, and a hard deadline. Cancellation, timeouts, crashes
 * and errors all end the same way: the whole process group is killed, the profile directory is
 * deleted and the proxy is closed. One inspection at a time.
 *
 * Isolation limits (documented, not hidden): Chromium's own sandbox is on, but there is no virtual
 * machine and no OS-level network wall around Chromium (macOS cannot nest an outer sandbox around
 * Chromium's sandbox); network confinement relies on Chromium's proxy/resolver settings plus the
 * proxy's policy. A Chromium exploit could escape it.
 */

const WORKER = path.join(process.cwd(), "src/lib/linkscan/dynamic/worker.mjs");
let running = false;

export interface DynamicOptions {
  timeoutMs?: number;
  observeMs?: number;
  proxy?: ProxyOptions;
  resolver?: Resolver;
  /** Test hook: called with the worker's PID and the run's private profile directory. */
  onStart?: (pid: number, profileDir: string) => void;
}

const empty = (status: DynamicSummary["status"], detail: string, durationMs = 0): DynamicSummary => ({
  status,
  detail,
  durationMs,
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
});

/**
 * Playwright starts Chromium in its OWN process group, so killing the worker's group is not enough:
 * every process whose command line contains this run's unique profile directory is killed too.
 */
export function killBrowsers(profileDir: string) {
  try {
    execFileSync("pkill", ["-9", "-f", profileDir], { stdio: "ignore" });
  } catch {
    /* none left */
  }
}

export async function runDynamicInspection(url: string, signal?: AbortSignal, opts: DynamicOptions = {}): Promise<DynamicSummary> {
  if (running) return empty("unavailable", "Another page inspection is already running — try again in a moment.");
  if (signal?.aborted) return empty("cancelled", "Cancelled.");
  running = true;
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? getEnv().DYNAMIC_INSPECTION_TIMEOUT_MS;
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "scamshield-inspect-"));
  const proxy = await startInspectionProxy({ resolver: opts.resolver, ...opts.proxy });
  const state: { last: DynamicSummary | null; final: DynamicSummary | null; killedFor: "timeout" | "cancelled" | null } = { last: null, final: null, killedFor: null };
  try {
    const cfg = JSON.stringify({ url, profileDir, proxyPort: proxy.port, timeoutMs, observeMs: opts.observeMs ?? 5000 });
    // CPU-time limit (s) and largest file the process tree may write (512-byte blocks ≈ 200 MB).
    // Minimal environment: the worker never sees API keys, database URLs or other secrets.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8" };
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const child = spawn("/bin/sh", ["-c", 'ulimit -t 120; ulimit -f 409600; exec "$0" "$@"', process.execPath, "--max-old-space-size=256", WORKER, cfg], {
      detached: true, // own process group → the whole tree (incl. Chromium) can be killed at once
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd: process.cwd(),
    });
    if (child.pid) opts.onStart?.(child.pid, profileDir);
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      killBrowsers(profileDir);
    };
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = /^(PARTIAL|RESULT) (\{.*\})$/.exec(line);
        if (!m) continue;
        try {
          const parsed = JSON.parse(m[2]) as DynamicSummary;
          if (m[1] === "RESULT") state.final = parsed;
          else state.last = parsed;
        } catch {
          /* ignore malformed line */
        }
      }
    });
    child.stderr.on("data", () => {}); // never surfaced to users
    const onAbort = () => {
      state.killedFor = "cancelled";
      killTree();
    };
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      state.killedFor = "timeout";
      killTree();
    }, timeoutMs + 5000);
    const code = await new Promise<number | null>((resolve) => child.on("close", (c: number | null) => resolve(c)));
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    killTree(); // reap any Chromium helpers still alive in the group

    const duration = Date.now() - t0;
    let result: DynamicSummary;
    const { last, final, killedFor } = state;
    if (killedFor === "cancelled") result = { ...(last ?? empty("cancelled", "")), status: "cancelled", detail: "Cancelled — partial observations only." };
    else if (killedFor === "timeout") result = { ...(last ?? empty("timeout", "")), status: "timeout", detail: "The inspection hit its time limit — partial observations only." };
    else if (final) result = final;
    else result = { ...(last ?? empty("failed", "")), status: "failed", detail: `The inspection browser stopped unexpectedly${code !== null ? ` (exit ${code})` : ""} — partial observations only.` };
    result.durationMs = duration;
    result.requests.blocked = proxy.log.blocked.slice(0, 50);
    for (const h of proxy.log.hosts.keys()) if (result.requests.thirdPartyHosts.length < 40 && !result.requests.thirdPartyHosts.includes(h) && result.finalUrl && !result.finalUrl.includes(h)) result.requests.thirdPartyHosts.push(h);
    return result;
  } catch (e) {
    logger.warn("dynamic_inspection_failed", { error: e });
    return empty("failed", "The inspection could not run.", Date.now() - t0);
  } finally {
    killBrowsers(profileDir);
    await proxy.close();
    rmSync(profileDir, { recursive: true, force: true });
    running = false;
  }
}
