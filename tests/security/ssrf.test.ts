import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRedirects, nodeTransport, type Transport } from "@/lib/url/fetcher";
import { assertSafeUrl, forbiddenHostnameReason, isBlockedIp, makeSafeLookup, UnsafeUrlError, type Resolver } from "@/lib/url/safety";

const resolverFrom =
  (table: Record<string, string[]>): Resolver =>
  async (h) => {
    if (!(h in table)) throw new Error("ENOTFOUND");
    return table[h];
  };

describe("SSRF: IP classification", () => {
  it.each([
    "127.0.0.1",
    "127.10.0.5",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.10",
    "169.254.169.254", // AWS/GCP/Azure metadata
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // AWS IPv6 metadata
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "142.250.183.14", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("SSRF: hostname policy", () => {
  it.each([
    ["localhost", "internal_hostname"],
    ["foo.localhost", "internal_hostname"],
    ["metadata.google.internal", "internal_hostname"],
    ["printer.local", "internal_hostname"],
    ["intranet", "single_label_hostname"],
    ["127.0.0.1", "private_ip"],
    ["service.svc.cluster.local", "internal_hostname"],
  ])("rejects %s", (host, reason) => {
    expect(forbiddenHostnameReason(host)).toBe(reason);
  });

  it("accepts public hostnames", () => {
    expect(forbiddenHostnameReason("example.com")).toBeNull();
  });
});

describe("SSRF: assertSafeUrl", () => {
  const resolver = resolverFrom({
    "public.example.com": ["93.184.216.34"],
    "rebind.example.com": ["93.184.216.34", "127.0.0.1"],
    "internal.example.com": ["10.0.0.5"],
    "v6internal.example.com": ["::1"],
  });

  it("allows a public host", async () => {
    await expect(assertSafeUrl("https://public.example.com/a", resolver)).resolves.toEqual(["93.184.216.34"]);
  });

  it.each([
    ["http://localhost/", "internal_hostname"],
    ["http://127.0.0.1/", "private_ip"],
    ["http://[::1]/", "private_ip"],
    ["http://0x7f000001/", "private_ip"], // WHATWG parser normalises to 127.0.0.1
    ["http://2130706433/", "private_ip"],
    ["http://169.254.169.254/latest/meta-data/", "private_ip"],
    ["http://internal.example.com/", "resolves_to_private_ip"],
    ["http://v6internal.example.com/", "resolves_to_private_ip"],
    ["http://rebind.example.com/", "resolves_to_private_ip"],
    ["ftp://public.example.com/", "protocol_not_allowed"],
    ["file:///etc/passwd", "protocol_not_allowed"],
    ["gopher://public.example.com/", "protocol_not_allowed"],
    ["http://public.example.com:22/", "port_not_allowed"],
    ["http://user:pass@public.example.com/", "credentials_in_url"],
    ["http://nonexistent.example.com/", "dns_failure"],
  ])("rejects %s (%s)", async (url, reason) => {
    await expect(assertSafeUrl(url, resolver)).rejects.toMatchObject({ reason });
  });
});

describe("SSRF: redirect validation", () => {
  const resolver = resolverFrom({ "a.example.com": ["93.184.216.34"], "b.example.com": ["93.184.216.35"] });
  const chain =
    (hops: Record<string, { status: number; location?: string }>): Transport =>
    async (url) =>
      hops[url.toString()] ?? { status: 200 };

  it("follows safe redirects and reports the chain", async () => {
    const res = await resolveRedirects("https://a.example.com/x", {
      maxRedirects: 5,
      timeoutMs: 1000,
      maxBytes: 1000,
      resolver,
      transport: chain({ "https://a.example.com/x": { status: 302, location: "https://b.example.com/y" } }),
    });
    expect(res.chain).toEqual(["https://a.example.com/x", "https://b.example.com/y"]);
    expect(res.finalStatus).toBe(200);
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/iam",
    "http://localhost:80/",
    "file:///etc/passwd",
    "http://[::ffff:127.0.0.1]/",
  ])("blocks a redirect to %s", async (target) => {
    const res = await resolveRedirects("https://a.example.com/x", {
      maxRedirects: 5,
      timeoutMs: 1000,
      maxBytes: 1000,
      resolver,
      transport: chain({ "https://a.example.com/x": { status: 301, location: target } }),
    });
    expect(res.stoppedReason).toBe("blocked");
  });

  it("stops redirect loops at the limit", async () => {
    const res = await resolveRedirects("https://a.example.com/loop", {
      maxRedirects: 3,
      timeoutMs: 1000,
      maxBytes: 1000,
      resolver,
      transport: async () => ({ status: 302, location: "https://a.example.com/loop" }),
    });
    expect(res.stoppedReason).toBe("max_redirects");
    expect(res.chain.length).toBe(4);
  });
});

describe("SSRF: connect-time DNS re-validation (rebinding)", () => {
  let server: http.Server;
  let port: number;
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.end("internal secret");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("safe lookup refuses private addresses", async () => {
    const lookup = makeSafeLookup(async () => ["127.0.0.1"]);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup("evil.example.com", {}, (e) => resolve(e)));
    expect(err?.code).toBe("ESSRFBLOCKED");
  });

  it("never connects when DNS flips to a private address after the pre-flight check", async () => {
    // First answer (pre-flight) is public, every later answer (connect time) is loopback.
    let calls = 0;
    const flipping: Resolver = async () => (calls++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const url = new URL(`http://rebind.example.com:${port}/`);
    await expect(assertSafeUrl(`http://rebind.example.com/`, flipping)).resolves.toBeTruthy();
    await expect(nodeTransport(url, { timeoutMs: 2000, maxBytes: 1000, resolver: flipping })).rejects.toMatchObject({
      code: "ESSRFBLOCKED",
    });
    expect(hits).toBe(0);
  });

  it("UnsafeUrlError carries a machine-readable reason", () => {
    expect(new UnsafeUrlError("x", "y").reason).toBe("x");
  });
});
