# SSRF Protection

ScamShield analyses attacker-supplied URLs. By default it **never fetches them** — URL risk is
computed statically (`src/lib/url/analyzer.ts`). Server-side fetching exists only to resolve
redirect chains (e.g. where a `bit.ly` link really goes) and requires BOTH:

- `URL_FETCH_ENABLED=true` on the server, and
- `followRedirects: true` in the `/api/v1/analyze/url` request.

## Guarantees (src/lib/url/safety.ts, src/lib/url/fetcher.ts)

1. **Protocols**: `http:` and `https:` only. `file:`, `gopher:`, `ftp:`, `data:`, `javascript:` are refused.
2. **Ports**: 80 and 443 only.
3. **No credentials** in URLs (`http://user:pass@host`).
4. **Hostnames**: must have an ICANN public suffix. Refused: `localhost`, `*.localhost`, `*.local`,
   `*.internal`, `*.lan`, `*.home.arpa`, `*.corp`, `*.cluster.local`, `metadata`,
   `metadata.google.internal`, single-label names, `*.in-addr.arpa`.
5. **Addresses**: every A/AAAA record must be public unicast. Blocked ranges:
   - IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (incl. 169.254.169.254 metadata), 172.16/12,
     192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
     224/4, 240/4.
   - IPv6: ::, ::1, IPv4-mapped (checked via the embedded IPv4), 64:ff9b::/96, 64:ff9b:1::/48,
     100::/64, 2001::/32 (Teredo), 2001:10::/28, 2001:db8::/32, 2002::/16 (6to4), fc00::/7
     (incl. fd00:ec2::254 metadata), fe80::/10, fec0::/10, ff00::/8.
   - Obfuscated forms (`0x7f000001`, `2130706433`, `017700000001`) are normalised by the WHATWG
     URL parser before checks.
   - If **any** record is private the host is refused (defeats mixed public/private A records).
6. **DNS rebinding**: the HTTP client uses a custom `lookup` that re-resolves and re-validates at
   connect time, so the socket can only connect to an address that passed the policy.
7. **Redirects**: followed manually; each `Location` is resolved against the current URL and goes
   through checks 1–6 again. Maximum `URL_FETCH_MAX_REDIRECTS` (default 5).
8. **Resource limits**: total timeout `URL_FETCH_TIMEOUT_MS` (5 s), body read cap
   `URL_FETCH_MAX_BYTES` (256 KB, body discarded), at most 3 URLs resolved per request.
9. **No ambient authority**: no cookies, no auth headers, `Accept-Encoding: identity`, fresh agent
   per request.
10. **Output**: only the redirect chain and final status are returned — never the response body.

## Pitfall found during implementation

Node's `net.BlockList` matches IPv4 addresses against IPv6 rules through IPv4-mapped addresses.
Adding `::ffff:0:0/96` to the IPv6 block list therefore blocks **all** IPv4. The test suite caught
this (public IPs were rejected); the rule is intentionally absent and mapped addresses are checked
through their embedded IPv4 address. Keep `tests/security/ssrf.test.ts` passing when editing the
lists.

## Tests

`tests/security/ssrf.test.ts` covers: every blocked range (incl. metadata v4/v6, mapped, NAT64,
6to4), public addresses allowed, hostname policy, protocol/port/credential refusal, DNS failures,
mixed records, redirect chains to loopback/metadata/`file://`/mapped IPv6, redirect loops, and a
real HTTP server on 127.0.0.1 that must receive **zero** connections when DNS flips from public
to loopback between pre-flight and connect.

## Operational advice

- Keep `URL_FETCH_ENABLED=false` unless redirect resolution is needed.
- Additionally restrict egress at the network layer (VPC egress rules / firewall) — defence in depth.
- If you run on a platform with metadata on a non-standard address, add it to the block list.
