import http from "node:http";
import https from "node:https";
import { assertSafeUrl, makeSafeLookup, systemResolver, UnsafeUrlError, type Resolver } from "@/lib/url/safety";

/**
 * SSRF-safe document fetch for STATIC inspection. The body is read as bytes (bounded) and parsed
 * as data — nothing is executed, rendered or saved to disk.
 *
 *  - every hop: protocol/port/host/DNS policy (`assertSafeUrl`) and connect-time re-validation of
 *    the resolved address (`makeSafeLookup`, defeats DNS rebinding); redirects re-checked hop by hop
 *  - limits: redirects, total time, bytes; no cookies, no credentials, no Referer, identity encoding
 *  - errors are classified (DNS, TLS, timeout, refused, blocked…) and reported, never hidden
 */

export type FetchFailure =
  | "blocked" // SSRF policy (private/internal/metadata address, bad port/scheme)
  | "dns" // name doesn't resolve
  | "tls" // certificate/handshake problem
  | "timeout"
  | "refused" // connection refused/reset
  | "too_many_redirects"
  | "bad_redirect"
  | "too_large"
  | "aborted"
  | "error";

export interface FetchedHop {
  url: string;
  status: number | null;
}

export interface FetchedDocument {
  chain: FetchedHop[];
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  contentDisposition: string | null;
  contentLength: number | null;
  /** First `maxBytes` of the final body (null when not fetched). */
  body: Buffer | null;
  truncated: boolean;
  failure: FetchFailure | null;
  failureDetail: string | null;
  /** TLS problem seen on a hop (expired/self-signed/wrong host…), even if a later hop worked. */
  tlsProblem: string | null;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  truncated: boolean;
}

export type DocTransport = (url: URL, opts: { timeoutMs: number; maxBytes: number; resolver: Resolver; signal?: AbortSignal }) => Promise<RawResponse>;

const header = (h: http.IncomingHttpHeaders, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

export const nodeDocTransport: DocTransport = (url, { timeoutMs, maxBytes, resolver, signal }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: makeSafeLookup(resolver) as unknown as typeof import("node:dns").lookup,
        rejectUnauthorized: true,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ScamShield-LinkInspector/2.0; +safety scanner)",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.5",
          "Accept-Encoding": "identity",
          "Accept-Language": "en",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let read = 0;
        let truncated = false;
        const finish = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              location: header(res.headers, "location"),
              "content-type": header(res.headers, "content-type"),
              "content-disposition": header(res.headers, "content-disposition"),
              "content-length": header(res.headers, "content-length"),
            },
            body: Buffer.concat(chunks),
            truncated,
          });
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
          res.destroy();
          finish();
          return;
        }
        res.on("data", (c: Buffer) => {
          if (read + c.length > maxBytes) {
            chunks.push(c.subarray(0, maxBytes - read));
            read = maxBytes;
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
          read += c.length;
        });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on("close", () => clearTimeout(timer));
    req.end();
  });

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|EPROTO/i;

export function classifyNetworkError(e: unknown): { failure: FetchFailure; detail: string } {
  const err = e as NodeJS.ErrnoException & { reason?: string };
  const code = err?.code ?? "";
  if (e instanceof UnsafeUrlError && e.reason === "dns_failure") return { failure: "dns", detail: "the website name does not resolve" };
  if (e instanceof UnsafeUrlError || code === "ESSRFBLOCKED") return { failure: "blocked", detail: err.reason ?? "destination not allowed" };
  if (code === "ABORT_ERR" || err?.name === "AbortError") return { failure: "aborted", detail: "cancelled" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return { failure: "dns", detail: "the website name does not resolve" };
  if (code === "ETIMEDOUT" || err?.message === "ETIMEDOUT") return { failure: "timeout", detail: "the website did not answer in time" };
  if (TLS_CODES.test(code) || TLS_CODES.test(err?.message ?? "")) return { failure: "tls", detail: `secure-connection problem (${code || "TLS"})` };
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return { failure: "refused", detail: "the connection was refused or dropped" };
  return { failure: "error", detail: code || "network error" };
}

export async function fetchDocument(
  start: string,
  opts: { maxRedirects: number; timeoutMs: number; maxBytes: number; resolver?: Resolver; transport?: DocTransport; signal?: AbortSignal },
): Promise<FetchedDocument> {
  const resolver = opts.resolver ?? systemResolver;
  const transport = opts.transport ?? nodeDocTransport;
  const deadline = Date.now() + opts.timeoutMs;
  const chain: FetchedHop[] = [];
  let tlsProblem: string | null = null;
  let current = new URL(start);
  const base = (failure: FetchFailure | null, detail: string | null, extra: Partial<FetchedDocument> = {}): FetchedDocument => ({
    chain,
    finalUrl: current.toString(),
    status: chain.at(-1)?.status ?? null,
    contentType: null,
    contentDisposition: null,
    contentLength: null,
    body: null,
    truncated: false,
    failure,
    failureDetail: detail,
    tlsProblem,
    ...extra,
  });

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    if (opts.signal?.aborted) return base("aborted", "cancelled");
    chain.push({ url: current.toString(), status: null });
    try {
      await assertSafeUrl(current, resolver);
    } catch (e) {
      const c = classifyNetworkError(e);
      return base(c.failure, c.detail);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return base("timeout", "the website did not answer in time");
    let res: RawResponse;
    try {
      res = await transport(current, { timeoutMs: remaining, maxBytes: opts.maxBytes, resolver, signal: opts.signal });
    } catch (e) {
      const c = classifyNetworkError(e);
      if (c.failure === "tls") tlsProblem = c.detail;
      return base(c.failure, c.detail);
    }
    chain[chain.length - 1].status = res.status;
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      let next: URL;
      try {
        next = new URL(res.headers.location, current);
      } catch {
        return base("bad_redirect", "the website sent an invalid redirect");
      }
      next.hash = "";
      current = next;
      continue;
    }
    const len = Number(res.headers["content-length"]);
    return base(null, null, {
      contentType: res.headers["content-type"] ?? null,
      contentDisposition: res.headers["content-disposition"] ?? null,
      contentLength: Number.isFinite(len) ? len : null,
      body: res.body,
      truncated: res.truncated,
    });
  }
  return base("too_many_redirects", `more than ${opts.maxRedirects} redirects`);
}
