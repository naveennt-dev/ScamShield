import http from "node:http";
import https from "node:https";
import { assertSafeUrl, makeSafeLookup, systemResolver, UnsafeUrlError, type Resolver } from "./safety";

/**
 * SSRF-safe redirect resolver. It only discovers where a link leads (status + Location chain);
 * it never returns or renders the response body. Guarantees:
 *  - every hop passes `assertSafeUrl` (protocol/port/host/DNS policy),
 *  - sockets connect only to addresses re-validated at connect time (`makeSafeLookup`),
 *  - bounded redirects, total timeout and bytes read; no cookies, no credentials, no auth headers.
 */

export interface HopResponse {
  status: number;
  location?: string;
}

export type Transport = (url: URL, opts: { timeoutMs: number; maxBytes: number; resolver: Resolver }) => Promise<HopResponse>;

export interface RedirectResolution {
  chain: string[];
  finalUrl: string;
  finalStatus?: number;
  stoppedReason?: "max_redirects" | "blocked" | "timeout" | "error";
  blockedReason?: string;
}

export const nodeTransport: Transport = (url, { timeoutMs, maxBytes, resolver }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: makeSafeLookup(resolver) as unknown as typeof import("node:dns").lookup,
        headers: {
          "User-Agent": "ScamShield-LinkInspector/1.0 (+safety scanner)",
          Accept: "text/html,*/*;q=0.5",
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read > maxBytes) res.destroy();
        });
        res.on("close", () => resolve({ status, location }));
        res.on("error", () => resolve({ status, location }));
        if (status >= 300 && status < 400) res.destroy(); // body irrelevant for redirects
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("ETIMEDOUT")), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on("close", () => clearTimeout(timer));
    req.end();
  });

export async function resolveRedirects(
  start: string,
  opts: {
    maxRedirects: number;
    timeoutMs: number;
    maxBytes: number;
    resolver?: Resolver;
    transport?: Transport;
  },
): Promise<RedirectResolution> {
  const resolver = opts.resolver ?? systemResolver;
  const transport = opts.transport ?? nodeTransport;
  const deadline = Date.now() + opts.timeoutMs;
  const chain: string[] = [];
  let current = new URL(start);

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    chain.push(current.toString());
    try {
      await assertSafeUrl(current, resolver);
    } catch (e) {
      if (e instanceof UnsafeUrlError) {
        return { chain, finalUrl: current.toString(), stoppedReason: "blocked", blockedReason: e.reason };
      }
      throw e;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { chain, finalUrl: current.toString(), stoppedReason: "timeout" };

    let res: HopResponse;
    try {
      res = await transport(current, { timeoutMs: remaining, maxBytes: opts.maxBytes, resolver });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ESSRFBLOCKED" || e instanceof UnsafeUrlError) {
        return { chain, finalUrl: current.toString(), stoppedReason: "blocked", blockedReason: "resolves_to_private_ip" };
      }
      const timedOut = err.message === "ETIMEDOUT" || err.code === "ETIMEDOUT";
      return { chain, finalUrl: current.toString(), stoppedReason: timedOut ? "timeout" : "error" };
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        return { chain, finalUrl: current.toString(), finalStatus: res.status, stoppedReason: "error" };
      }
      next.hash = "";
      current = next;
      continue;
    }
    return { chain, finalUrl: current.toString(), finalStatus: res.status };
  }
  return { chain, finalUrl: current.toString(), stoppedReason: "max_redirects" };
}
