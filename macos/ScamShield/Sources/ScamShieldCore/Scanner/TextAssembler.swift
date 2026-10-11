import CoreGraphics
import Foundation

/// One recognised piece of text. `boundingBox` is in Vision's normalised image space
/// (0…1, origin bottom-left).
public struct TextObservation: Sendable, Equatable {
    public let text: String
    public let boundingBox: CGRect
    public let confidence: Double

    public init(text: String, boundingBox: CGRect, confidence: Double) {
        self.text = text
        self.boundingBox = boundingBox
        self.confidence = confidence
    }
}

public struct OCRResult: Sendable, Equatable {
    public let text: String
    public let observations: [TextObservation]
    /// Mean observation confidence (0…1); 0 when nothing was recognised.
    public let confidence: Double

    public init(text: String, observations: [TextObservation], confidence: Double) {
        self.text = text
        self.observations = observations
        self.confidence = confidence
    }
}

/// Turns unordered OCR observations into readable text:
/// sort by reading order → group into lines → join → paragraph breaks from vertical gaps →
/// whitespace cleanup that never alters URL characters.
public enum TextAssembler {
    /// - Parameter imageAspect: image width ÷ height, so horizontal and vertical distances can be
    ///   compared in the same unit (normalised x and y have different scales on a wide screen).
    public static func assemble(_ observations: [TextObservation], imageAspect: CGFloat = 1) -> OCRResult {
        let valid = observations.filter(isUsable)
        guard !valid.isEmpty else { return OCRResult(text: "", observations: [], confidence: 0) }

        // Top-left origin; x converted to "height units".
        let aspect = imageAspect.isFinite && imageAspect > 0 ? imageAspect : 1
        let items: [Item] = valid.map { o in
            let b = o.boundingBox
            return Item(o: o, top: 1 - b.maxY, bottom: 1 - b.minY, left: b.minX * aspect, right: b.maxX * aspect)
        }

        // Layout blocks (Phase 6 fix): a full-screen capture holds many unrelated columns and
        // windows side by side. Reading whole-screen rows interleaved a chat message with desktop
        // labels and other windows ("…ka bill veenTan…icate.pdf"), which broke the detector's
        // phrases. Observations are therefore grouped into spatial blocks first; each block is read
        // on its own and blocks are separated by a blank line.
        let blocks = groupIntoBlocks(items)
        let texts = blocks.map(readBlock).filter { !$0.isEmpty }
        let text = texts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let confidence = valid.map(\.confidence).reduce(0, +) / Double(valid.count)
        return OCRResult(text: text, observations: valid, confidence: max(0, min(1, confidence)))
    }

    struct Item {
        let o: TextObservation
        let top: CGFloat, bottom: CGFloat, left: CGFloat, right: CGFloat
        var height: CGFloat { bottom - top }
    }

    /// Two observations belong to the same block when they are on the same line and close, or on
    /// adjacent lines (gap ≤ 1.1 line heights — the same threshold as the paragraph break) of the same column (horizontal overlap).
    static func groupIntoBlocks(_ items: [Item]) -> [[Item]] {
        var parent = Array(items.indices)
        func find(_ i: Int) -> Int { var i = i; while parent[i] != i { parent[i] = parent[parent[i]]; i = parent[i] }; return i }
        func union(_ a: Int, _ b: Int) { let ra = find(a), rb = find(b); if ra != rb { parent[rb] = ra } }

        for i in items.indices {
            for j in items.indices where j > i {
                let a = items[i], b = items[j]
                let h = max(a.height, b.height), hMin = min(a.height, b.height)
                let vOverlap = min(a.bottom, b.bottom) - max(a.top, b.top)
                let hGap = max(a.left, b.left) - min(a.right, b.right) // < 0 when x-ranges overlap
                if vOverlap >= 0.5 * hMin, hGap <= 3 * h {
                    union(i, j) // same line, nearby
                    continue
                }
                let vGap = max(a.top, b.top) - min(a.bottom, b.bottom)
                if vGap >= -0.5 * hMin, vGap <= 1.1 * h, hGap < 0, abs(a.height - b.height) <= 0.6 * h {
                    union(i, j) // next line of the same column (similar font size)
                }
            }
        }
        var groups: [Int: [Item]] = [:]
        for i in items.indices { groups[find(i), default: []].append(items[i]) }
        // Reading order of blocks: top to bottom, then left to right.
        return groups.values.sorted { a, b in
            let ta = a.map(\.top).min()!, tb = b.map(\.top).min()!
            if abs(ta - tb) > 0.01 { return ta < tb }
            return a.map(\.left).min()! < b.map(\.left).min()!
        }
    }

    /// Lines of one block in reading order (pieces on the same line joined with a space).
    static func readBlock(_ block: [Item]) -> String {
        let sorted = block.sorted { $0.top == $1.top ? $0.left < $1.left : $0.top < $1.top }
        var rows: [[Item]] = []
        for item in sorted {
            if var last = rows.last {
                let rowTop = last.map(\.top).min()!, rowBottom = last.map(\.bottom).max()!
                let overlap = min(rowBottom, item.bottom) - max(rowTop, item.top)
                if overlap >= 0.5 * min(rowBottom - rowTop, item.height) {
                    last.append(item)
                    rows[rows.count - 1] = last
                    continue
                }
            }
            rows.append([item])
        }
        return rows.map { row in
            row.sorted { $0.left < $1.left }.map { cleanLine($0.o.text) }.filter { !$0.isEmpty }.joined(separator: " ")
        }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    }

    /// Rejects malformed observations (NaN/infinite/empty boxes, blank text).
    static func isUsable(_ o: TextObservation) -> Bool {
        let b = o.boundingBox
        let finite: Bool = b.minX.isFinite && b.minY.isFinite && b.width.isFinite && b.height.isFinite && o.confidence.isFinite
        guard finite, b.width > 0, b.height > 0 else { return false }
        return !o.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static let multiSpace = try! NSRegularExpression(pattern: "[ \\t\\u00A0]{2,}")
    /// OCR sometimes inserts spaces inside a scheme: "https : //", "https:/ /".
    private static let brokenScheme = try! NSRegularExpression(pattern: "\\b(https?|HTTPS?)\\s*:\\s*/\\s*/\\s*", options: [])

    private static let urlToken = try! NSRegularExpression(pattern: "(?:https?://|www\\.)[^\\s]+", options: [.caseInsensitive])

    /// Whitespace cleanup plus two narrowly-scoped URL repairs:
    ///  1. broken schemes ("https : //" → "https://"),
    ///  2. inside URL tokens only, "|" → "l". Vision often reads a lowercase l as a vertical bar
    ///     (e.g. "#login" → "#|ogin"); "|" is not a valid unencoded URL character (RFC 3986), so this
    ///     can only restore, never corrupt, a real URL.
    /// No other URL characters (domain, path, query, fragment) are rewritten.
    public static func cleanLine(_ raw: String) -> String {
        var s = raw.replacingOccurrences(of: "\u{00A0}", with: " ")
        s = brokenScheme.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "$1://")
        s = multiSpace.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        let ns = s as NSString
        let result = NSMutableString(string: s)
        for m in urlToken.matches(in: s, range: NSRange(location: 0, length: ns.length)).reversed() {
            let fixed = ns.substring(with: m.range).replacingOccurrences(of: "|", with: "l")
            result.replaceCharacters(in: m.range, with: fixed)
        }
        return (result as String).trimmingCharacters(in: .whitespaces)
    }
}
