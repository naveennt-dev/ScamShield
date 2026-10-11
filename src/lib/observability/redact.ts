/**
 * Redaction helpers used by the logger and before persisting/previewing user content.
 */

const SENSITIVE_KEY =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|otp|pin|cvv|session|credential|private/i;

/** Mask values that look like OTPs, card numbers, account numbers, phone numbers, Aadhaar, etc. */
export function maskSensitiveText(text: string): string {
  return (
    text
      // URL query strings / fragments often carry tokens or personal data → keep scheme+host+path
      .replace(/\b(https?:\/\/[^\s?#<>"']+)[?#][^\s<>"']*/gi, "$1?…")
      // Bearer / sk- style keys
      .replace(/\b(sk|pk|rk)-[a-z0-9-]{8,}\b/gi, "[REDACTED_KEY]")
      .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      // email local part
      .replace(/\b([a-z0-9._%+-])[a-z0-9._%+-]*@([a-z0-9.-]+\.[a-z]{2,})\b/gi, "$1***@$2")
      // UPI IDs (name@bank)
      .replace(/\b([a-z0-9.\-_]{2,})@(ok\w+|ybl|ibl|axl|upi|paytm|apl|icici|sbi|hdfc\w*)\b/gi, "***@$2")
      // runs of 4+ digits (allowing spaces/dashes inside, e.g. card numbers) → keep last 2 digits
      .replace(/\d(?:[\s-]?\d){3,}/g, (m) => {
        const digits = m.replace(/\D/g, "");
        return `${"#".repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
      })
  );
}

/** Deep-redact an object for logging. Strings under sensitive keys are fully removed. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Log strings are not content, but may be URLs: never log query strings/fragments.
    const v = value.replace(/\b(https?:\/\/[^\s?#<>"']+)[?#][^\s<>"']*/gi, "$1?…");
    return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: maskSensitiveText(value.message).slice(0, 300) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForLog(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redactForLog(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** A short, masked preview suitable for storage/display (never full content). */
export function safePreview(text: string, max = 240): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const masked = maskSensitiveText(collapsed);
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}
