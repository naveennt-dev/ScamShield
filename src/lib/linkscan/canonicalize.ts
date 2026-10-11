import { domainToASCII, domainToUnicode } from "node:url";
import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";

/**
 * Parse, validate and canonicalise a user-typed link WITHOUT any network access.
 *
 * Handles: missing scheme ("example.com/x"), surrounding junk (quotes, <>, trailing punctuation),
 * defanged forms (hxxp, [.], (dot)), internationalised domains (Unicode ⇄ punycode), percent-encoded
 * hostnames, mixed case, default ports, fragments, dot-segments, control/invisible characters and
 * over-long input. Malformed input yields `ok: false` with a reason — never a guess.
 */

export interface CanonicalLink {
  ok: true;
  /** Canonical absolute URL (punycode host, no fragment, no default port). */
  url: string;
  scheme: string;
  /** ASCII (punycode) hostname, or the IP literal. */
  hostname: string;
  /** Unicode form for display (same as hostname when plain ASCII). */
  displayHostname: string;
  registrableDomain: string | null;
  isIp: boolean;
  isPunycode: boolean;
  /** What was changed to obtain the canonical form (shown to the user as transparency). */
  notes: string[];
  /** True when the input was written in a disguised form (hxxp, [.] …). */
  defanged: boolean;
}

export interface MalformedLink {
  ok: false;
  reason: "empty" | "too_long" | "control_characters" | "unsupported_scheme" | "no_host" | "invalid_host" | "unparsable";
  detail: string;
}

export const MAX_LINK_LENGTH = 4096;
const WEB_SCHEMES = new Set(["http:", "https:"]);
/** Schemes we recognise (to explain them) but never treat as web links. */
const KNOWN_NON_WEB = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "ftp:", "intent:", "about:", "chrome:", "mailto:", "tel:", "sms:"]);

export function canonicalizeLink(input: string): CanonicalLink | MalformedLink {
  const notes: string[] = [];
  let s = input.trim();
  if (!s) return { ok: false, reason: "empty", detail: "Nothing was entered." };
  if (s.length > MAX_LINK_LENGTH) return { ok: false, reason: "too_long", detail: `The link is longer than ${MAX_LINK_LENGTH} characters.` };

  // Invisible / bidi characters are a classic disguise; control characters make parsing ambiguous.
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, reason: "control_characters", detail: "The link contains control characters." };
  if (/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/.test(s)) {
    s = s.replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "");
    notes.push("Removed invisible characters hidden in the link.");
  }
  s = s.replace(/^[<"'(\[]+|[>"')\],.;!?]+$/g, "");

  let defanged = false;
  const refanged = s
    .replace(/^hxxp(s?):\/\//i, "http$1://")
    .replace(/\[(\.|dot)\]|\((\.|dot)\)|\{(\.|dot)\}/gi, ".")
    .replace(/\[:\]/g, ":");
  if (refanged !== s) {
    defanged = true;
    notes.push("The link was written in a disguised form (e.g. hxxp, [.]) — restored it for analysis.");
    s = refanged;
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (schemeMatch && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(s)) {
    const scheme = `${schemeMatch[1].toLowerCase()}:`;
    if (!WEB_SCHEMES.has(scheme)) {
      return {
        ok: false,
        reason: "unsupported_scheme",
        detail: KNOWN_NON_WEB.has(scheme)
          ? `"${scheme}" links are not web pages (they can run code, open files or apps) — never open them from a message.`
          : `"${scheme}" is not a web link.`,
      };
    }
  } else {
    s = `https://${s.replace(/^\/\//, "")}`;
    notes.push("No scheme given — analysed as https://.");
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "unparsable", detail: "This is not a valid web address." };
  }
  if (!u.hostname) return { ok: false, reason: "no_host", detail: "The link has no website name." };

  // WHATWG URL already lower-cases, IDNA-encodes and decodes %-escapes in the host; validate the result.
  let host = u.hostname.replace(/^\[|\]$/g, "");
  if (/%/.test(input.split(/[/?#]/)[2] ?? "")) notes.push("The website name was percent-encoded — decoded it.");
  const ip = isIP(host);
  if (!ip) {
    if (host.endsWith(".")) {
      host = host.slice(0, -1);
      u.hostname = host;
      notes.push("Removed a trailing dot from the website name.");
    }
    const ascii = domainToASCII(host);
    if (!ascii || !/^[a-z0-9.-]+$/.test(ascii) || ascii.split(".").some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) {
      return { ok: false, reason: "invalid_host", detail: "The website name is not valid." };
    }
    host = ascii;
  }
  if (u.hash) notes.push("Ignored the #fragment (it is never sent to the website).");
  u.hash = "";
  if (u.username || u.password) notes.push("The link hides text before an '@' — the real website is what comes after it.");

  const display = ip ? host : domainToUnicode(host) || host;
  const isPunycode = !ip && host.split(".").some((l) => l.startsWith("xn--"));
  if (isPunycode) notes.push(`The website name uses international characters: ${display} (encoded as ${host}).`);
  return {
    ok: true,
    url: u.toString(),
    scheme: u.protocol.replace(":", ""),
    hostname: host,
    displayHostname: display,
    registrableDomain: ip ? null : parseDomain(host).domain ?? null,
    isIp: Boolean(ip),
    isPunycode,
    notes,
    defanged,
  };
}
