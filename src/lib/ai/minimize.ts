import { maskSensitiveText } from "@/lib/observability/redact";

/**
 * Data minimisation before any text leaves the machine for remote analysis (Phase 4).
 *
 * Kept: the wording of the message (what the scam analysis needs) and link HOSTNAMES.
 * Removed / masked:
 *   - URL paths, query strings and fragments (may carry tokens, session ids, personal data) →
 *     `https://host/…`
 *   - API keys, bearer tokens, e-mail local parts, UPI handles, and every run of 4+ digits
 *     (OTPs, card/account/Aadhaar/phone numbers keep only their last 2 digits) — via the same
 *     masking used for stored previews
 *   - whitespace runs (layout noise from OCR)
 *   - everything beyond `maxChars`
 * Screenshots/images are never part of the input: only OCR'd text reaches this function.
 */

export interface MinimizedText {
  text: string;
  originalChars: number;
  truncated: boolean;
  urlsShortened: number;
}

/**
 * Links with a scheme or "www.", and bare "host.tld/path" links (scam texts often drop the
 * scheme). The lookbehind keeps e-mail domains and dotted words out.
 */
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s/?#<>"']+|(?<![@\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?=[/?#]))([^\s<>"']*)/gi;

export function minimizeForRemote(input: string, maxChars: number): MinimizedText {
  let urlsShortened = 0;
  const withoutUrlDetail = input.replace(URL_RE, (_m, hostPart: string, rest: string) => {
    if (rest && rest !== "/") {
      urlsShortened++;
      return `${hostPart}/…`;
    }
    return hostPart;
  });
  const masked = maskSensitiveText(withoutUrlDetail)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = masked.length > maxChars;
  return {
    text: truncated ? masked.slice(0, maxChars) : masked,
    originalChars: input.length,
    truncated,
    urlsShortened,
  };
}
