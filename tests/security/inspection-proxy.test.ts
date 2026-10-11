import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startInspectionProxy, type InspectionProxy } from "@/lib/linkscan/dynamic/proxy";

/** Every SSRF boundary of the inspection browser's proxy, exercised directly (no browser). */

let proxy: InspectionProxy | null = null;
afterEach(async () => {
  await proxy?.close();
  proxy = null;
});

function connect(p: InspectionProxy, target: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(p.port, "127.0.0.1", () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) {
        s.destroy();
        resolve(buf.split("\r\n")[0]);
      }
    });
    s.on("error", () => resolve("error"));
    s.on("close", () => resolve(buf.split("\r\n")[0] || "closed"));
  });
}

function get(p: InspectionProxy, url: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: p.port, method: "GET", path: url }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(-1));
    req.end();
  });
}

const resolverOf = (map: Record<string, string[]>) => async (h: string) => {
  if (!map[h]) throw new Error("NXDOMAIN");
  return map[h];
};

describe("inspection proxy: SSRF boundaries", () => {
  it("refuses ordinary (origin-form) requests — what a web page could send to this port", async () => {
    proxy = await startInspectionProxy({ resolver: resolverOf({ "example.com": ["93.184.216.34"] }) });
    expect(await get(proxy, "/http://example.com/")).toBe(400);
    expect(await get(proxy, "/latest/meta-data/")).toBe(400);
    expect(proxy.log.hosts.size).toBe(0);
  });

  it.each([
    ["127.0.0.1:443", "loopback"],
    ["[::1]:443", "IPv6 loopback"],
    ["169.254.169.254:443", "cloud metadata"],
    ["10.1.2.3:443", "private"],
    ["192.168.1.1:443", "private"],
    ["[::ffff:127.0.0.1]:443", "IPv4-mapped IPv6"],
    ["[fd00:ec2::254]:443", "AWS IPv6 metadata"],
    ["0.0.0.0:443", "this-network"],
    ["localhost:443", "internal name"],
    ["metadata.google.internal:443", "internal name"],
    ["intranet:443", "single-label name"],
  ])("CONNECT %s (%s) is refused", async (target) => {
    proxy = await startInspectionProxy({ resolver: resolverOf({}) });
    expect(await connect(proxy, target)).toMatch(/403/);
    expect(proxy.log.blocked.length).toBe(1);
  });

  it("a public name that resolves to a private address is refused (and so is a mixed answer)", async () => {
    proxy = await startInspectionProxy({ resolver: resolverOf({ "evil-example.com": ["10.0.0.5"], "mixed-example.com": ["93.184.216.34", "127.0.0.1"] }) });
    expect(await connect(proxy, "evil-example.com:443")).toMatch(/403/);
    expect(await connect(proxy, "mixed-example.com:443")).toMatch(/403/);
    expect(proxy.log.blocked.map((b) => b.reason)).toEqual(["resolves_to_private_ip", "resolves_to_private_ip"]);
  });

  it("only port 443 can be tunnelled and only plain http:80 can be proxied", async () => {
    proxy = await startInspectionProxy({ resolver: resolverOf({ "example.com": ["93.184.216.34"] }) });
    expect(await connect(proxy, "example.com:22")).toMatch(/403/);
    expect(await connect(proxy, "example.com:8443")).toMatch(/403/);
    expect(await get(proxy, "http://example.com:8080/")).toBe(403);
    expect([400, 403]).toContain(await get(proxy, "ftp://example.com/"));
    expect(await get(proxy, "http://127.0.0.1/")).toBe(403);
    expect(await get(proxy, "http://2130706433/")).toBe(403); // decimal IPv4 → 127.0.0.1
    expect(await get(proxy, "http://0x7f.0.0.1/")).toBe(403); // hex IPv4
  });

  it("connects to the address it validated (no second DNS lookup for rebinding)", async () => {
    let lookups = 0;
    // A fixture "public" server: the resolver answers once with a public-looking address the test maps.
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    proxy = await startInspectionProxy({
      resolver: async () => {
        lookups++;
        return lookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"]; // a rebinding resolver
      },
    });
    await connect(proxy, "rebind-example.com:443");
    expect(lookups).toBe(1);
    server.close();
  });

  it("enforces the connection limit", async () => {
    proxy = await startInspectionProxy({ resolver: resolverOf({}), maxConnections: 2 });
    for (let i = 0; i < 2; i++) await connect(proxy, "nope.example:443");
    expect(await connect(proxy, "nope.example:443")).toMatch(/429/);
  });

  it("enforces the per-connection size limit", async () => {
    const big = http.createServer((_q, res) => res.end(Buffer.alloc(200_000, 1)));
    await new Promise<void>((r) => big.listen(0, "127.0.0.1", () => r()));
    const port = (big.address() as net.AddressInfo).port;
    proxy = await startInspectionProxy({ maxBytesPerConnection: 50_000, testHosts: { "big.test": { host: "127.0.0.1", port } } });
    await get(proxy, "http://big.test/");
    await new Promise((r) => setTimeout(r, 200));
    expect(proxy.log.blocked.some((b) => b.reason === "size limit reached")).toBe(true);
    big.close();
  });

  it("the loopback test-host map cannot be used outside the test runner", async () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(startInspectionProxy({ testHosts: { "x.test": { host: "127.0.0.1", port: 1 } } })).rejects.toThrow(/only available under the test runner/);
    } finally {
      process.env.VITEST = saved;
    }
  });
});
