// Browser replacement for node:url domainToASCII / domainToUnicode (IDNA via punycode).
import punycode from "punycode/";
export function domainToASCII(d: string): string {
  try { return d.toLowerCase().split(".").map((l) => (/[^\x00-\x7f]/.test(l) ? `xn--${punycode.encode(l)}` : l)).join("."); } catch { return ""; }
}
export function domainToUnicode(d: string): string {
  try { return d.toLowerCase().split(".").map((l) => (l.startsWith("xn--") ? punycode.decode(l.slice(4)) : l)).join("."); } catch { return ""; }
}
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export default { domainToASCII, domainToUnicode, URL, URLSearchParams };
