import Foundation

/// A user's own feedback on a past result. Stored ONLY on this Mac (`reports.json`, 0600) —
/// never uploaded. It holds no message text: just the verdict, when, and what the result was.
public struct LocalReport: Codable, Sendable, Equatable, Identifiable {
    /// The user's feedback on one result. Stored locally only; it never changes the detection model
    /// directly (see docs/design/shared-learning-and-url-intelligence.md).
    public enum Verdict: String, Codable, Sendable, CaseIterable {
        /// The result was right (a warning on a scam, or green on a genuine message).
        case correct
        /// Green, but it was a scam.
        case missedScam = "missed_scam"
        /// A warning, but the message was genuine.
        case falsePositive = "false_positive"
        /// The user isn't sure either way.
        case unsure

        public static func options(for level: RiskLevel?) -> [Verdict] {
            guard let level else { return [] }
            return level == .safe ? [.correct, .missedScam, .unsure] : [.correct, .falsePositive, .unsure]
        }

        public func title(for level: RiskLevel?) -> String {
            switch self {
            case .correct: return level == .safe ? "Correct — it's genuine" : "Correct — it's a scam"
            case .missedScam: return "Missed scam — this is fraud"
            case .falsePositive: return "False alarm — this is genuine"
            case .unsure: return "Not sure"
            }
        }

        /// Reports saved before the four-option feedback said "scam", "suspicious" or "false_positive"
        /// (the old "ScamShield got it wrong" button); what they meant depends on the result.
        static func migrating(_ raw: String, level: RiskLevel) -> Verdict? {
            // "Got it wrong" on a GREEN result meant the scam was missed — not a false alarm.
            if raw == "false_positive" && level == .safe { return .missedScam }
            if let v = Verdict(rawValue: raw) { return v }
            guard raw == "scam" || raw == "suspicious" else { return nil }
            return level == .safe ? .missedScam : .correct
        }
    }

    public init(id: UUID, historyEntryID: UUID, verdict: Verdict, date: Date, riskLevel: RiskLevel, riskScore: Int,
                categoryLabel: String?, linkHosts: [String], provenance: String) {
        self.id = id; self.historyEntryID = historyEntryID; self.verdict = verdict; self.date = date
        self.riskLevel = riskLevel; self.riskScore = riskScore; self.categoryLabel = categoryLabel
        self.linkHosts = linkHosts; self.provenance = provenance
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let level = try c.decode(RiskLevel.self, forKey: .riskLevel)
        let raw = try c.decode(String.self, forKey: .verdict)
        guard let v = Verdict.migrating(raw, level: level) else {
            throw DecodingError.dataCorruptedError(forKey: .verdict, in: c, debugDescription: "unknown verdict \(raw)")
        }
        self.init(id: try c.decode(UUID.self, forKey: .id), historyEntryID: try c.decode(UUID.self, forKey: .historyEntryID),
                  verdict: v, date: try c.decode(Date.self, forKey: .date), riskLevel: level,
                  riskScore: try c.decode(Int.self, forKey: .riskScore), categoryLabel: try c.decodeIfPresent(String.self, forKey: .categoryLabel),
                  linkHosts: try c.decodeIfPresent([String].self, forKey: .linkHosts) ?? [], provenance: try c.decode(String.self, forKey: .provenance))
    }

    public var id: UUID
    public var historyEntryID: UUID
    public var verdict: Verdict
    public var date: Date
    /// Copied from the result (not from the message): level, score, category, link hosts.
    public var riskLevel: RiskLevel
    public var riskScore: Int
    public var categoryLabel: String?
    public var linkHosts: [String]
    /// Always "local-user": kept apart from any verified or imported intelligence.
    public var provenance: String
}

@MainActor
@Observable
public final class ReportStore {
    public private(set) var reports: [LocalReport] = []
    public private(set) var lastError: String?
    @ObservationIgnored public let fileURL: URL
    @ObservationIgnored private let now: () -> Date

    /// Guard against accidental floods (e.g. a stuck key): at most this many new reports per day.
    public static let maxPerDay = 30

    public enum ReportError: Error, Equatable, Sendable { case rateLimited, storage(String), notAssessed }

    public init(directory: URL = HistoryStore.defaultDirectory, now: @escaping () -> Date = Date.init) {
        fileURL = directory.appendingPathComponent("reports.json")
        self.now = now
        load()
    }

    public func report(for entryID: UUID) -> LocalReport? { reports.first { $0.historyEntryID == entryID } }

    /// One report per history entry: reporting again replaces the verdict (no duplicates).
    @discardableResult
    public func submit(_ verdict: LocalReport.Verdict, for entry: HistoryEntry) throws -> LocalReport {
        guard let level = entry.riskLevel, let score = entry.riskScore else { throw ReportError.notAssessed }
        let dayAgo = now().addingTimeInterval(-86_400)
        let existing = reports.firstIndex { $0.historyEntryID == entry.id }
        if existing == nil, reports.filter({ $0.date > dayAgo }).count >= Self.maxPerDay { throw ReportError.rateLimited }
        let r = LocalReport(id: existing.map { reports[$0].id } ?? UUID(), historyEntryID: entry.id, verdict: verdict, date: now(),
                            riskLevel: level, riskScore: score, categoryLabel: entry.categoryLabel,
                            linkHosts: entry.linkHosts, provenance: "local-user")
        if let existing { reports[existing] = r } else { reports.insert(r, at: 0) }
        try persistOrThrow()
        return r
    }

    public func delete(_ id: UUID) {
        reports.removeAll { $0.id == id }
        try? persistOrThrow()
    }

    public func deleteReports(forEntry entryID: UUID) {
        reports.removeAll { $0.historyEntryID == entryID }
        try? persistOrThrow()
    }

    public func clearAll() {
        reports = []
        try? persistOrThrow()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        if let r = try? d.decode([LocalReport].self, from: data) { reports = r } else {
            try? FileManager.default.moveItem(at: fileURL, to: fileURL.deletingLastPathComponent().appendingPathComponent("reports.corrupt.json"))
            lastError = "Your saved reports couldn't be read and were set aside."
        }
    }

    private func persistOrThrow() throws {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let e = JSONEncoder()
            e.dateEncodingStrategy = .iso8601
            try e.encode(reports).write(to: fileURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            lastError = nil
        } catch {
            lastError = "Reports couldn't be saved (\(error.localizedDescription))."
            throw ReportError.storage(error.localizedDescription)
        }
    }
}
