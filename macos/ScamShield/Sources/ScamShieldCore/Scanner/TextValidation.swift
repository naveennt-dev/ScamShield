import Foundation

/// Prepares OCR text — which is completely UNTRUSTED (it is whatever was on screen, including
/// text written to manipulate software or AI) — for analysis.
///
/// It only normalises; it never interprets. Nothing in the text is executed, opened, or used to
/// change app behaviour. Prompt-injection text is passed through unchanged as data; the backend
/// treats it as untrusted (delimited prompts, deterministic floors — see docs/security/threat-model.md).
public enum TextValidation {
    /// Matches the backend's MAX_MESSAGE_LENGTH default.
    public static let maxCharacters = 10_000

    public struct Prepared: Sendable, Equatable {
        public let text: String
        public let wasTruncated: Bool
        public let lineCount: Int
        public let urlCount: Int
    }

    public static func prepare(_ raw: String) -> Prepared? {
        var scalars = String.UnicodeScalarView()
        for u in raw.unicodeScalars {
            switch u.value {
            case 0x0A, 0x09: scalars.append(u) // newline, tab
            case 0x0D: continue // CR → dropped (CRLF becomes LF)
            case 0x00...0x1F, 0x7F...0x9F: continue // other C0/C1 controls
            case 0x202A...0x202E, 0x2066...0x2069: continue // bidi embedding/override/isolate controls
            default: scalars.append(u)
            }
        }
        var text = String(scalars).precomposedStringWithCanonicalMapping
        // Collapse runs of blank lines to a single paragraph break.
        text = text.replacingOccurrences(of: "\n[ \t]*\n(?:[ \t]*\n)+", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) else { return nil }

        var truncated = false
        if text.count > maxCharacters {
            text = String(text.prefix(maxCharacters))
            truncated = true
        }
        return Prepared(
            text: text,
            wasTruncated: truncated,
            lineCount: text.split(separator: "\n", omittingEmptySubsequences: true).count,
            urlCount: URLDetector.urls(in: text).count
        )
    }
}

/// Finds URLs for display/counting only. Phase 2 NEVER opens or fetches them.
public enum URLDetector {
    private static let detector = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    public static func urls(in text: String) -> [String] {
        detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
            guard let r = Range(m.range, in: text), m.url?.scheme?.hasPrefix("http") == true else { return nil }
            return String(text[r])
        }
    }
}
