import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { parse as parseDomain } from "tldts";

/**
 * SSRF protection. Every server-side outbound request to a user-influenced URL MUST go through
 * `assertSafeUrl` (pre-flight) AND use `safeLookup` (connect-time) so that DNS rebinding between
 * the check and the connection cannot reach an internal address.
 *
 * Policy (deny by default):
 *  - protocols: http, https only
 *  - ports: 80, 443 only
 *  - no credentials in URL
 *  - hostnames: must have a public (ICANN) suffix; internal names are rejected
 *  - every resolved address must be public unicast (all A/AAAA records are checked)
 */

export class UnsafeUrlError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "UnsafeUrlError";
    this.reason = reason;
  }
}

const blocked = new BlockList();
// IPv4 special-purpose ranges (RFC 6890 and friends)
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. 169.254.169.254 cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv6 special-purpose ranges
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  // NOTE: do NOT add ::ffff:0:0/96 here. Node's BlockList treats every IPv4 address as
  // IPv4-mapped, so that rule would block ALL IPv4. Mapped addresses are checked through their
  // embedded IPv4 address (embeddedV4 below, and BlockList's own v4 rule mapping).
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:10::", 28], // ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed private v4)
  ["fc00::", 7], // unique local (incl. fd00:ec2::254 AWS metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

function embeddedV4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) return m[1];
  const hex = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** True if the address is NOT a public unicast address. */
export function isBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "").split("%")[0]; // strip brackets and zone id
  const family = isIP(clean);
  if (family === 4) return blocked.check(clean, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(clean);
    if (v4 && isIP(v4) === 4 && blocked.check(v4, "ipv4")) return true;
    return blocked.check(clean, "ipv6");
  }
  return true; // unparsable → treat as unsafe
}

const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".in-addr.arpa",
  ".ip6.arpa",
  ".cluster.local",
];
const FORBIDDEN_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes",
  "kubernetes.default",
]);

/** Static hostname policy (no DNS). Returns a reason string if forbidden. */
export function forbiddenHostnameReason(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return "empty_host";
  if (isIP(h)) return isBlockedIp(h) ? "private_ip" : null;
  if (FORBIDDEN_HOSTS.has(h)) return "internal_hostname";
  if (FORBIDDEN_HOST_SUFFIXES.some((s) => h.endsWith(s))) return "internal_hostname";
  if (!h.includes(".")) return "single_label_hostname";
  const info = parseDomain(h);
  if (!info.domain || !info.isIcann) return "non_public_suffix";
  return null;
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs: LookupAddress[]) => {
      if (err) reject(err);
      else resolve(addrs.map((a) => a.address));
    });
  });

/**
 * Pre-flight validation. Throws `UnsafeUrlError` if the URL must not be fetched.
 * Returns the validated public addresses.
 */
export async function assertSafeUrl(raw: string | URL, resolver: Resolver = systemResolver): Promise<string[]> {
  let u: URL;
  try {
    u = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new UnsafeUrlError("invalid_url", "URL could not be parsed");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError("protocol_not_allowed", `Protocol ${u.protocol} is not allowed`);
  }
  if (u.username || u.password) throw new UnsafeUrlError("credentials_in_url", "Credentials in URL are not allowed");
  if (!ALLOWED_PORTS.has(u.port)) throw new UnsafeUrlError("port_not_allowed", `Port ${u.port} is not allowed`);

  const host = u.hostname.replace(/^\[|\]$/g, "");
  const reason = forbiddenHostnameReason(host);
  if (reason) throw new UnsafeUrlError(reason, "Destination is not a public internet host");

  if (isIP(host)) return [host];

  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new UnsafeUrlError("dns_failure", "Hostname could not be resolved");
  }
  if (addrs.length === 0) throw new UnsafeUrlError("dns_failure", "Hostname has no addresses");
  // Conservative: if ANY record points inward, refuse (defeats split A-record rebinding tricks).
  if (addrs.some(isBlockedIp)) throw new UnsafeUrlError("resolves_to_private_ip", "Hostname resolves to a non-public address");
  return addrs;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Connect-time DNS lookup for node:http(s) `lookup` option. Re-validates the addresses actually
 * used for the socket, closing the DNS-rebinding window.
 */
export function makeSafeLookup(resolver: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback) => {
    resolver(hostname)
      .then((addrs) => {
        if (addrs.length === 0 || addrs.some(isBlockedIp)) {
          const err = new UnsafeUrlError("resolves_to_private_ip", "Blocked at connect time") as unknown as NodeJS.ErrnoException;
          err.code = "ESSRFBLOCKED";
          callback(err, "", 4);
          return;
        }
        const all = typeof options === "object" && options?.all;
        if (all) callback(null, addrs.map((a) => ({ address: a, family: isIP(a) })));
        else callback(null, addrs[0], isIP(addrs[0]));
      })
      .catch((e) => callback(e as NodeJS.ErrnoException, "", 4));
  };
}
