import CryptoKit
import Foundation

/// One remembered scan — the minimum needed to look back at a result.
///
/// Deliberately absent: the screenshot (never exists on disk), the OCR text, full URLs. `excerpt`
/// is only set if the user opted in, and is redacted + truncated. `contentDigest` is a salted
/// SHA-256 (per-install salt) used solely to avoid duplicate entries; it cannot be reversed.
public struct HistoryEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var scanID: UUID
    public var date: Date
    /// nil for a scan that could not be completed (see `failure`) — never a made-up "safe".
    public var riskLevel: RiskLevel?
    public var riskScore: Int?
    public var categoryLabel: String?
    public var headline: String
    /// Up to 3 reasons from the local engine (redacted).
    public var reasons: [String]
    /// "Checked on this Mac only." / "+ remote AI (model)" / why remote wasn't used.
    public var source: String
    public var analysisMode: AnalysisMode
    public var remoteUsed: Bool
    /// Link hostnames only (no paths/queries), at most 3.
    public var linkHosts: [String]
    /// Legacy short excerpt (entries from before full-text saving). New entries use `text`.
    public var excerpt: String?
    /// The scanned text with numbers, e-mails, UPI IDs and link paths masked (when "Save scanned
    /// text" is on — the default). nil when the user turned it off.
    public var text: String?
    /// Why this colour (matched words, ML, links, AI, adjustments) for this exact scan.
    public var decision: DecisionExplanation?
    public var contentDigest: String
    /// Full screen or selected region (nil for entries recorded before this field existed).
    public var captureMode: CaptureMode?
    /// Why the scan could not be assessed (capture/OCR/service failure). nil = completed.
    public var failure: String?
    /// The service's category id (e.g. "kyc"); nil for older entries.
    public var category: String? = nil

    public var completed: Bool { failure == nil && riskLevel != nil }

    /// `source` in current wording. Entries saved by older versions said "this Mac" and named the
    /// remote model; the stored file is left as it is.
    public var displaySource: String {
        source
            .replacingOccurrences(of: #"remote AI \([^)]*\)"#, with: "AI second opinion", options: .regularExpression)
            .replacingOccurrences(of: "Remote AI not used", with: "AI second opinion not used")
            .replacingOccurrences(of: "this Mac", with: "this device")
            .replacingOccurrences(of: "the free model", with: "the AI")
            .replacingOccurrences(of: "no free model", with: "no AI model")
    }
}

public enum HistoryStoreError: Error, Equatable, Sendable {
    case unavailable(String)
}

/// File-backed scan history in `~/Library/Application Support/ScamShield/history.json`
/// (directory 0700, file 0600 — readable only by the current macOS user).
///
/// Robustness: writes are atomic; a corrupt file is moved aside (`history.corrupt-<time>.json`) and
/// history starts empty; any storage failure is reported via `lastError` and never affects
/// scanning. Growth is bounded by `maxEntries` and `retentionDays`.
@MainActor
@Observable
public final class HistoryStore {
    public private(set) var entries: [HistoryEntry] = []
    public private(set) var lastError: String?

    public var isEnabled: Bool { didSet { defaults.set(isEnabled, forKey: Keys.enabled) } }
    /// Save the scanned text (numbers masked) with each entry. On by default; can be turned off.
    public var saveText: Bool { didSet { defaults.set(saveText, forKey: Keys.saveText) } }
    public var retentionDays: Int { didSet { defaults.set(retentionDays, forKey: Keys.retention); prune(); persist() } }

    public static let retentionChoices = [7, 30, 90, 365]
    public static let maxEntries = 500
    /// Same content + same verdict within this window updates the existing entry (retries, re-scans).
    public static let duplicateWindow: TimeInterval = 120
    static let excerptLength = 140

    @ObservationIgnored public let fileURL: URL
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let salt: Data

    enum Keys {
        static let enabled = "historyEnabled", saveText = "historySaveText", retention = "historyRetentionDays", salt = "historyDigestSalt"
    }

    public static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ScamShield", isDirectory: true)
    }

    public init(directory: URL = HistoryStore.defaultDirectory, defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.fileURL = directory.appendingPathComponent("history.json")
        self.defaults = defaults
        self.now = now
        self.isEnabled = defaults.object(forKey: Keys.enabled) as? Bool ?? true
        self.saveText = defaults.object(forKey: Keys.saveText) as? Bool ?? true
        let r = defaults.integer(forKey: Keys.retention)
        self.retentionDays = Self.retentionChoices.contains(r) ? r : 90
        if let s = defaults.data(forKey: Keys.salt), s.count == 32 {
            salt = s
        } else {
            var bytes = [UInt8](repeating: 0, count: 32)
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            salt = Data(bytes)
            defaults.set(salt, forKey: Keys.salt)
        }
        load()
    }

    // MARK: Recording

    /// Records a finished, real (non-sample) scan. Returns the entry, or nil if nothing was stored.
    /// `text` is used only in memory (digest + optional redacted excerpt) and is not retained.
    @discardableResult
    public func record(scanID: UUID, summary: AnalysisSummary, text: String, mode: AnalysisMode, captureMode: CaptureMode? = nil) -> HistoryEntry? {
        guard isEnabled, !summary.isSample else { return nil }
        let presentation = ResultPresentation(summary: summary)
        let digest = self.digest(text)
        let date = now()

        // Same scan delivered twice → nothing new.
        if entries.contains(where: { $0.scanID == scanID }) { return nil }

        var entry = HistoryEntry(
            id: UUID(), scanID: scanID, date: date,
            riskLevel: summary.riskLevel, riskScore: summary.riskScore,
            categoryLabel: summary.category == "other" ? nil : summary.categoryLabel,
            headline: presentation.headline,
            reasons: summary.reasons.prefix(3).map { String(Redactor.redact($0).prefix(240)) },
            source: presentation.source ?? "Checked on this device only.",
            analysisMode: mode, remoteUsed: summary.remote?.used ?? false,
            linkHosts: Self.hosts(in: text),
            excerpt: nil,
            text: saveText ? Self.maskedText(text) : nil,
            decision: summary.decision,
            contentDigest: digest,
            captureMode: captureMode,
            failure: nil,
            category: summary.category)

        // Retry / re-scan of the same content with the same verdict shortly after → update in place.
        if let i = entries.firstIndex(where: { $0.completed && $0.contentDigest == digest && $0.riskLevel == summary.riskLevel && date.timeIntervalSince($0.date) < Self.duplicateWindow }) {
            entry.id = entries[i].id
            entries.remove(at: i)
        }
        entries.insert(entry, at: 0)
        prune()
        persist()
        return entry
    }

    /// Records a scan the user started that could not be assessed (no score — it was NOT judged safe).
    /// Records a link scan. Only the service's redacted address is kept (query values, tokens and
    /// e-mail addresses already removed), masked again here.
    @discardableResult
    public func recordLink(_ r: LinkReport, mode: AnalysisMode) -> HistoryEntry? {
        guard isEnabled else { return nil }
        guard let level = r.riskLevel else {
            return recordFailure(scanID: UUID(), reason: "Link: \(r.summary)", mode: mode, captureMode: .link)
        }
        let address = Redactor.redact(r.url ?? r.hostname ?? "")
        let reasons = r.evidence.filter { $0.severity != "low" }.prefix(3).map { String(Redactor.redact($0.detail).prefix(240)) }
        let e = HistoryEntry(
            id: UUID(), scanID: UUID(), date: now(), riskLevel: level, riskScore: nil, categoryLabel: nil,
            headline: "\(r.verdictLabel) — \(r.displayHostname ?? r.hostname ?? "link")",
            reasons: reasons.isEmpty ? [r.summary] : reasons,
            source: r.disclosures.isEmpty ? "Checked on this device only." : "Checked online (see the link report).",
            analysisMode: mode, remoteUsed: r.coverage.contains { $0.id == "ai" && $0.status == "done" },
            linkHosts: [r.hostname].compactMap { $0 }, excerpt: nil, text: saveText ? address : nil, decision: nil,
            contentDigest: "", captureMode: .link, failure: nil)
        entries.insert(e, at: 0)
        prune()
        persist()
        return e
    }

    @discardableResult
    public func recordFailure(scanID: UUID, reason: String, mode: AnalysisMode, captureMode: CaptureMode?) -> HistoryEntry? {
        guard isEnabled, !entries.contains(where: { $0.scanID == scanID }) else { return nil }
        let e = HistoryEntry(id: UUID(), scanID: scanID, date: now(), riskLevel: nil, riskScore: nil, categoryLabel: nil,
                             headline: "Unable to assess", reasons: [], source: "", analysisMode: mode,
                             remoteUsed: false, linkHosts: [], excerpt: nil, text: nil, decision: nil, contentDigest: "", captureMode: captureMode,
                             failure: String(Redactor.redact(reason).prefix(200)))
        entries.insert(e, at: 0)
        prune()
        persist()
        return e
    }

    public func delete(_ id: UUID) {
        entries.removeAll { $0.id == id }
        persist()
    }

    /// Deletes everything. The UI asks for confirmation before calling this.
    public func clearAll() {
        entries = []
        persist()
    }

    public func entry(_ id: UUID) -> HistoryEntry? { entries.first { $0.id == id } }

    // MARK: Helpers

    func digest(_ text: String) -> String {
        let normalized = text.lowercased().components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        var h = SHA256()
        h.update(data: salt)
        h.update(data: Data(normalized.utf8))
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Longest text kept per entry.
    static let maxTextLength = 4000

    /// The scanned text with sensitive values masked (Redactor), paragraph breaks kept.
    static func maskedText(_ text: String) -> String {
        let masked = Redactor.redact(text).trimmingCharacters(in: .whitespacesAndNewlines)
        return masked.count > maxTextLength ? String(masked.prefix(maxTextLength - 1)) + "…" : masked
    }

    static func excerpt(_ text: String) -> String {
        let oneLine = text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        let r = Redactor.redact(oneLine)
        return r.count > excerptLength ? String(r.prefix(excerptLength - 1)) + "…" : r
    }

    static func hosts(in text: String) -> [String] {
        var out: [String] = []
        for token in text.components(separatedBy: .whitespacesAndNewlines) where token.contains(".") {
            let t = token.trimmingCharacters(in: CharacterSet(charactersIn: "()[]{}<>,;:!?\"'"))
            guard t.lowercased().hasPrefix("http") || t.lowercased().hasPrefix("www.") else { continue }
            if let host = URL(string: t.lowercased().hasPrefix("www.") ? "http://\(t)" : t)?.host, !out.contains(host) {
                out.append(host)
            }
            if out.count == 3 { break }
        }
        return out
    }

    private func prune() {
        let cutoff = now().addingTimeInterval(-Double(retentionDays) * 86_400)
        entries.removeAll { $0.date < cutoff }
        if entries.count > Self.maxEntries { entries.removeLast(entries.count - Self.maxEntries) }
    }

    // MARK: Storage

    private func load() {
        let fm = FileManager.default
        guard fm.fileExists(atPath: fileURL.path) else { return }
        do {
            let data = try Data(contentsOf: fileURL)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            entries = try decoder.decode([HistoryEntry].self, from: data).sorted { $0.date > $1.date }
            prune()
        } catch {
            // Corrupt or unreadable: keep a copy for inspection, start fresh. Never blocks scanning.
            let stamp = ISO8601DateFormatter().string(from: now()).replacingOccurrences(of: ":", with: "-")
            try? fm.moveItem(at: fileURL, to: fileURL.deletingLastPathComponent().appendingPathComponent("history.corrupt-\(stamp).json"))
            entries = []
            lastError = "Your scan history file couldn't be read and was set aside; history starts empty."
        }
    }

    private func persist() {
        do {
            let fm = FileManager.default
            let dir = fileURL.deletingLastPathComponent()
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(entries).write(to: fileURL, options: [.atomic])
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            lastError = nil
        } catch {
            lastError = "Scan history couldn't be saved (\(error.localizedDescription)). Scanning still works."
        }
    }
}
