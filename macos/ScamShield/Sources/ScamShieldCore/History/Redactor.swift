import Foundation

/// Masks sensitive content before anything is retained locally (history excerpts, reasons).
/// Mirrors the backend's `maskSensitiveText` plus URL shortening:
///   - URLs → scheme + host only (paths/queries may carry tokens or personal data)
///   - e-mail local parts, UPI handles, API keys / bearer tokens
///   - every run of 4+ digits (OTPs, card/account/phone/Aadhaar numbers) → keeps only the last 2
public enum Redactor {
    private static func re(_ p: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: p, options: [.caseInsensitive])
    }

    private static let url = re(#"\b((?:https?://|www\.)[^\s/?#<>"']+)[^\s<>"']*"#)
    /// Bare "host.tld/path" links (no scheme) — path and query removed, host kept.
    private static let bareURL = re(#"(?<![@\w.-])((?:[a-z0-9-]+\.)+[a-z]{2,24})[/?#][^\s<>"']*"#)
    private static let key = re(#"\b(?:sk|pk|rk)-[a-z0-9-]{8,}\b"#)
    private static let bearer = re(#"\bbearer\s+[a-z0-9._~+/-]+=*"#)
    private static let email = re(#"\b([a-z0-9._%+-])[a-z0-9._%+-]*@([a-z0-9.-]+\.[a-z]{2,})\b"#)
    private static let upi = re(#"\b[a-z0-9.\-_]{2,}@([a-z][a-z0-9]{1,15})\b"#)
    private static let digits = re(#"\d(?:[\s-]?\d){3,}"#)

    public static func redact(_ text: String) -> String {
        var s = text
        s = replace(url, in: s) { m, ns in ns.substring(with: m.range(at: 1)) + (m.range.length > m.range(at: 1).length ? "/…" : "") }
        s = replace(bareURL, in: s) { m, ns in ns.substring(with: m.range(at: 1)) + "/…" }
        s = replace(key, in: s) { _, _ in "[REDACTED_KEY]" }
        s = replace(bearer, in: s) { _, _ in "Bearer [REDACTED]" }
        s = replace(email, in: s) { m, ns in "\(ns.substring(with: m.range(at: 1)))***@\(ns.substring(with: m.range(at: 2)))" }
        s = replace(upi, in: s) { m, ns in "***@\(ns.substring(with: m.range(at: 1)))" }
        s = replace(digits, in: s) { m, ns in
            let d = ns.substring(with: m.range).filter(\.isNumber)
            return String(repeating: "#", count: max(0, d.count - 2)) + d.suffix(2)
        }
        return s
    }

    private static func replace(_ re: NSRegularExpression, in s: String, with f: (NSTextCheckingResult, NSString) -> String) -> String {
        let ns = s as NSString
        var out = "", last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += f(m, ns)
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}
