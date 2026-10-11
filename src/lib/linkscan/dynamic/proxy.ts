import http from "node:http";
import net from "node:net";
import { assertSafeUrl, systemResolver, UnsafeUrlError, type Resolver } from "@/lib/url/safety";

/**
 * SSRF-filtering forward proxy for the isolated inspection browser. Every connection the browser
 * makes — page loads, sub-resources, XHR/fetch, WebSockets — must come through here:
 *
 *  - only http (port 80, absolute-URI requests) and HTTPS/WSS tunnels (CONNECT to port 443)
 *  - the destination passes the same policy as every other outbound request (`assertSafeUrl`:
 *    public hostnames only, no internal names, no loopback/private/link-local/metadata/reserved
 *    addresses, IPv4/IPv6/mapped forms normalised) and the socket is opened to the VALIDATED IP —
 *    so a second DNS answer (rebinding) can never redirect it
 *  - exposure: loopback only, alive only for one inspection, proxy-form requests only (CONNECT or
 *    absolute URI) — an ordinary web page in the user's browser cannot use it. (A per-run
 *    Proxy-Authorization secret was tried and dropped: Playwright's proxy-auth handling intercepts
 *    traffic and stalls heavy pages. Another program running as the user could use the proxy for
 *    those seconds, but only to reach public sites it can already reach directly.)
 *  - limits: connections, bytes per connection and in total, idle time
 *  - a log of every destination and every blocked attempt (what the page tried to reach)
 */

export interface ProxyLog {
  hosts: Map<string, number>;
  blocked: Array<{ target: string; reason: string }>;
  bytesIn: number;
  connections: number;
}

export interface InspectionProxy {
  port: number;
  log: ProxyLog;
  close(): Promise<void>;
}

export interface ProxyOptions {
  resolver?: Resolver;
  maxConnections?: number;
  maxBytesTotal?: number;
  maxBytesPerConnection?: number;
  idleMs?: number;
  /**
   * TEST ONLY: route these exact hostnames to a local fixture server. Refused unless running under
   * the test runner, so production can never reach loopback through it.
   */
  testHosts?: Record<string, { host: string; port: number }>;
}

const ALLOWED_TUNNEL_PORTS = new Set([443]);

export async function startInspectionProxy(opts: ProxyOptions = {}): Promise<InspectionProxy> {
  const resolver = opts.resolver ?? systemResolver;
  const maxConn = opts.maxConnections ?? 400;
  const maxTotal = opts.maxBytesTotal ?? 60 * 1024 * 1024;
  const maxPer = opts.maxBytesPerConnection ?? 15 * 1024 * 1024;
  const idle = opts.idleMs ?? 15_000;
  if (opts.testHosts && !process.env.VITEST) throw new Error("testHosts is only available under the test runner");
  const log: ProxyLog = { hosts: new Map(), blocked: [], bytesIn: 0, connections: 0 };
  const sockets = new Set<net.Socket>();

  const block = (target: string, reason: string) => {
    if (log.blocked.length < 100) log.blocked.push({ target: target.slice(0, 200), reason });
  };
  const count = (host: string) => log.hosts.set(host, (log.hosts.get(host) ?? 0) + 1);

  /**
   * Validate and return the addresses to connect to (ALL of them already checked as public).
   * IPv4 first: many networks have no IPv6 route, and a dead first address would stall the page.
   */
  async function destination(hostname: string, port: number, scheme: "http" | "https"): Promise<{ hosts: string[]; port: number }> {
    const fixture = opts.testHosts?.[hostname.toLowerCase()];
    if (fixture) return { hosts: [fixture.host], port: fixture.port };
    const addrs = await assertSafeUrl(new URL(`${scheme}://${hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname}:${port}/`), resolver);
    return { hosts: [...addrs.filter((a) => net.isIPv4(a)), ...addrs.filter((a) => !net.isIPv4(a))].slice(0, 4), port };
  }

  /** Connect to the first validated address that answers (each attempt bounded). */
  function connectValidated(hosts: string[], port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const attempt = (i: number) => {
        if (i >= hosts.length) return reject(new Error("unreachable"));
        const s = net.connect({ host: hosts[i], port });
        const t = setTimeout(() => s.destroy(new Error("connect timeout")), 5000);
        s.once("connect", () => {
          clearTimeout(t);
          resolve(s);
        });
        s.once("error", () => {
          clearTimeout(t);
          s.destroy();
          attempt(i + 1);
        });
      };
      attempt(0);
    });
  }

  const pipeLimited = (from: net.Socket, to: net.Socket, inbound: boolean) => {
    let n = 0;
    from.on("data", (chunk: Buffer) => {
      n += chunk.length;
      if (inbound) log.bytesIn += chunk.length;
      if (n > maxPer || log.bytesIn > maxTotal) {
        block("(transfer)", "size limit reached");
        from.destroy();
        to.destroy();
      }
    });
    from.pipe(to);
  };

  const server = http.createServer(async (req, res) => {
    // Plain-http request in absolute-URI form: "GET http://host/path HTTP/1.1". Origin-form
    // ("GET /path") — the only form a web page can send to this port — is refused.
    let target: URL;
    try {
      if (!/^https?:\/\//i.test(req.url ?? "")) throw new Error("not proxy form");
      target = new URL(req.url ?? "");
    } catch {
      block(String(req.url ?? "").slice(0, 80), "not_a_proxy_request");
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:" || (target.port && target.port !== "80" && !opts.testHosts?.[target.hostname])) {
      block(target.toString(), "protocol_or_port_not_allowed");
      res.writeHead(403).end();
      return;
    }
    if (++log.connections > maxConn) {
      block(target.host, "connection limit reached");
      res.writeHead(429).end();
      return;
    }
    let dest: { hosts: string[]; port: number };
    try {
      dest = await destination(target.hostname, 80, "http");
    } catch (e) {
      block(target.host, e instanceof UnsafeUrlError ? e.reason : "invalid destination");
      res.writeHead(403).end();
      return;
    }
    count(target.hostname);
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(
      { host: dest.hosts[0], port: dest.port, method: req.method, path: `${target.pathname}${target.search}`, headers: { ...headers, host: target.host }, timeout: idle },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        let n = 0;
        up.on("data", (c: Buffer) => {
          n += c.length;
          log.bytesIn += c.length;
          if (n > maxPer || log.bytesIn > maxTotal) {
            block(target.host, "size limit reached");
            up.destroy();
            res.destroy();
          }
        });
        up.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const m = /^(\[[0-9a-f:.]+\]|[^:]+):(\d+)$/i.exec(req.url ?? "");
    const host = m?.[1].replace(/^\[|\]$/g, "") ?? "";
    const port = Number(m?.[2]);
    if (!m || (!ALLOWED_TUNNEL_PORTS.has(port) && !opts.testHosts?.[host.toLowerCase()])) {
      block(req.url ?? "?", "port_not_allowed");
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (++log.connections > maxConn) {
      block(host, "connection limit reached");
      client.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return;
    }
    let dest: { hosts: string[]; port: number };
    try {
      dest = await destination(host, port, "https");
    } catch (e) {
      block(`${host}:${port}`, e instanceof UnsafeUrlError ? e.reason : "invalid destination");
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    count(host);
    let upstream: net.Socket;
    try {
      upstream = await connectValidated(dest.hosts, dest.port);
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    sockets.add(upstream);
    upstream.setTimeout(idle, () => upstream.destroy());
    client.setTimeout(idle, () => client.destroy());
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on("error", () => client.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    pipeLimited(upstream, client, true);
    pipeLimited(client, upstream, false);
  });
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
