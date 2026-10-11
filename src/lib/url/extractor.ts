import { parse as parseDomain } from "tldts";
import type { ExtractedUrl } from "./types";

/**
 * URL extraction from free text. Handles:
 *  - explicit http(s) URLs and `www.` prefixes,
 *  - bare domains with a valid public suffix ("sbi-kyc-update.xyz/login"),
 *  - "defanged" URLs (hxxp://, example[.]com, example(dot)com).
 * Extraction is purely textual — nothing is fetched.
 */

export const MAX_URLS = 20;

/** TLDs that are far more often file extensions in messages than domains. */
const AMBIGUOUS_BARE_TLDS = new Set(["zip", "mov", "py", "sh", "md", "rs", "pl", "ps", "nl"]);

export function refang(text: string): string {
  return text
    .replace(/\bhxxp(s?):\/\//gi, "http$1://")
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}/g, ".")
    .replace(/\s*\[\s*dot\s*\]\s*|\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\[:\]/g, ":");
}

const EXPLICIT = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const BARE =
  /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})(?::\d{2,5})?(?:\/[^\s<>"'`]*)?/gi;

/** Bare IPv4 with a path or port ("45.12.9.3/login") — a dotted quad alone is too ambiguous. */
const BARE_IP = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5}\/?|\/)[^\s<>"'`]*/g;

function trimTrailing(s: string): string {
  let out = s.replace(/[.,;:!?'"*]+$/, "");
  // drop an unmatched closing bracket: "(see example.com)"
  while (/[)\]}>]$/.test(out)) {
    const close = out[out.length - 1];
    const open = { ")": "(", "]": "[", "}": "{", ">": "<" }[close]!;
    if (out.split(open).length >= out.split(close).length) break;
    out = out.slice(0, -1).replace(/[.,;:!?'"]+$/, "");
  }
  return out;
}

export function normalizeUrl(input: string): string | null {
  let candidate = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `http://${candidate}`;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  // WHATWG URL already lower-cases host, strips default ports and normalises IPv4 forms.
  return u.toString();
}

/** The link only exists in the text after refanging (written as example[.]com, hxxp://, (dot) …). */
function wasObfuscated(original: string, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const lower = original.toLowerCase();
  return !lower.includes(host) || lower.includes(`hxxp://${host}`) || lower.includes(`hxxps://${host}`);
}

export function extractUrls(text: string): ExtractedUrl[] {
  const refanged = refang(text);
  if (refanged !== text) {
    return extractFrom(refanged).map((u) => ({ ...u, obfuscated: wasObfuscated(text, u.url) }));
  }
  return extractFrom(text);
}

function extractFrom(refanged: string): ExtractedUrl[] {
  const found = new Map<string, ExtractedUrl>();
  const covered: Array<[number, number]> = [];

  for (const m of refanged.matchAll(EXPLICIT)) {
    const raw = trimTrailing(m[0]);
    const url = normalizeUrl(raw);
    covered.push([m.index!, m.index! + m[0].length]);
    if (url && !found.has(url)) found.set(url, { url, raw: raw.slice(0, 500), bare: false });
    if (found.size >= MAX_URLS) return [...found.values()];
  }

  for (const m of refanged.matchAll(BARE)) {
    const start = m.index!;
    if (covered.some(([a, b]) => start >= a && start < b)) continue;
    const raw = trimTrailing(m[0]);
    const host = raw.split(/[/:?#]/)[0].toLowerCase();
    const info = parseDomain(host);
    if (!info.domain || !info.isIcann || !info.publicSuffix) continue;
    const tld = info.publicSuffix.split(".").pop()!;
    if (AMBIGUOUS_BARE_TLDS.has(tld) && !raw.includes("/")) continue;
    const url = normalizeUrl(raw);
    if (url && !found.has(url)) found.set(url, { url, raw: raw.slice(0, 500), bare: true });
    if (found.size >= MAX_URLS) return [...found.values()];
  }

  for (const m of refanged.matchAll(BARE_IP)) {
    const start = m.index!;
    if (covered.some(([a, b]) => start >= a && start < b)) continue;
    const raw = trimTrailing(m[0]);
    const url = normalizeUrl(raw);
    if (url && !found.has(url)) found.set(url, { url, raw: raw.slice(0, 500), bare: true });
    if (found.size >= MAX_URLS) break;
  }
  return [...found.values()];
}
