import Foundation
import Testing
@testable import ScamShieldCore

private func tempDir() -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("scamshield-history-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

private func defaults() -> UserDefaults {
    let n = "scamshield.history.tests.\(UUID().uuidString)"
    let d = UserDefaults(suiteName: n)!
    d.removePersistentDomain(forName: n)
    return d
}

private let scamText = """
Dear SBI customer, your KYC has expired. Share OTP 482913 now.
Update at https://sbi-kyc-update.xyz/verify?session=SECRET123 or mail ravi.kumar@gmail.com, pay ravi@okaxis, call +91 98765 43210
"""

private func summary(_ level: RiskLevel = .critical, sample: Bool = false, remote: RemoteAnalysisInfo? = nil) -> AnalysisSummary {
    AnalysisSummary(classification: level == .safe ? .safe : .scam, riskLevel: level, riskScore: level == .safe ? 3 : 91, confidence: 0.8,
                    category: "kyc", categoryLabel: "KYC Scam",
                    reasons: ["Asks you to share a one-time password (OTP) 482913.", "Link https://sbi-kyc-update.xyz/verify?session=SECRET123 imitates SBI."],
                    isSample: sample, remote: remote)
}

@MainActor
@Suite("Phase 5 — scan history", .serialized)
struct HistoryStoreTests {
    @Test func newEntryHoldsOnlyMinimalData() throws {
        let dir = tempDir()
        let s = HistoryStore(directory: dir, defaults: defaults())
        let e = try #require(s.record(scanID: UUID(), summary: summary(), text: scamText, mode: .localOnly))
        #expect(e.riskLevel == .critical && e.riskScore == 91 && e.categoryLabel == "KYC Scam")
        #expect(e.source == "Checked on this device only.")
        #expect(e.analysisMode == .localOnly && !e.remoteUsed)
        #expect(e.linkHosts == ["sbi-kyc-update.xyz"])
        // The scanned text is saved by default (user request) — with every sensitive value masked.
        let t = try #require(e.text)
        #expect(t.contains("KYC has expired") && t.contains("Share OTP"))
        let raw = try String(contentsOf: s.fileURL, encoding: .utf8)
        for secret in ["482913", "SECRET123", "/verify", "ravi.kumar", "ravi@okaxis", "98765"] {
            #expect(!raw.contains(secret), "history file must not contain \(secret)")
        }
        #expect(!raw.contains("image") && !raw.contains("png") && !raw.contains("screenshot"))
    }

    @Test func persistsAcrossRestart() throws {
        let dir = tempDir(), d = defaults()
        let s1 = HistoryStore(directory: dir, defaults: d)
        s1.record(scanID: UUID(), summary: summary(), text: scamText, mode: .localOnly)
        s1.record(scanID: UUID(), summary: summary(.safe), text: "Lunch at 1?", mode: .remoteAssisted)
        let s2 = HistoryStore(directory: dir, defaults: d)
        #expect(s2.entries.count == 2)
        #expect(s2.entries.first?.riskLevel == .safe) // newest first
        #expect(s2.entries.map(\.contentDigest) == s1.entries.map(\.contentDigest)) // same salt after restart
    }

    @Test func deleteAndClearAll() throws {
        let dir = tempDir(), d = defaults()
        let s = HistoryStore(directory: dir, defaults: d)
        let a = try #require(s.record(scanID: UUID(), summary: summary(), text: "one", mode: .localOnly))
        s.record(scanID: UUID(), summary: summary(), text: "two", mode: .localOnly)
        s.delete(a.id)
        #expect(s.entries.count == 1 && s.entry(a.id) == nil)
        #expect(HistoryStore(directory: dir, defaults: d).entries.count == 1)
        s.clearAll()
        #expect(s.entries.isEmpty)
        #expect(HistoryStore(directory: dir, defaults: d).entries.isEmpty)
    }

    @Test func duplicatesFromRetriesAreNotAdded() throws {
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let s = HistoryStore(directory: tempDir(), defaults: defaults(), now: { clock })
        let scan = UUID()
        #expect(s.record(scanID: scan, summary: summary(), text: scamText, mode: .localOnly) != nil)
        #expect(s.record(scanID: scan, summary: summary(), text: scamText, mode: .localOnly) == nil) // same scan delivered twice
        clock += 30
        s.record(scanID: UUID(), summary: summary(), text: scamText + "  ", mode: .localOnly) // "Scan again" 30 s later
        #expect(s.entries.count == 1)
        #expect(s.entries[0].date == clock)
        clock += 600
        s.record(scanID: UUID(), summary: summary(), text: scamText, mode: .localOnly) // much later → a new entry
        #expect(s.entries.count == 2)
    }

    @Test func savedTextIsMaskedBoundedAndCanBeTurnedOff() throws {
        let d = defaults()
        let s = HistoryStore(directory: tempDir(), defaults: d)
        #expect(s.saveText) // on by default
        let long = scamText + String(repeating: " filler words here", count: 400)
        let e = try #require(s.record(scanID: UUID(), summary: summary(), text: long, mode: .localOnly))
        let t = try #require(e.text)
        #expect(t.count <= HistoryStore.maxTextLength)
        for secret in ["482913", "SECRET123", "ravi.kumar", "98765", "/verify"] { #expect(!t.contains(secret)) }
        #expect(e.reasons.allSatisfy { !$0.contains("482913") && !$0.contains("SECRET123") })
        s.saveText = false
        #expect(!HistoryStore(directory: tempDir(), defaults: d).saveText) // setting persisted
        let off = try #require(s.record(scanID: UUID(), summary: summary(), text: "Other message text", mode: .localOnly))
        #expect(off.text == nil)
    }

    @Test func decisionIsStoredWithTheEntry() throws {
        let s = HistoryStore(directory: tempDir(), defaults: defaults())
        var sum = summary()
        sum.decision = DecisionExplanation(colour: "red", why: "Red: final score 91/100 …", basis: ["Safety rules: 2 matched"],
                                           matches: [.init(rule: "Asks you to share an OTP", text: "share otp ######13", severity: "high")])
        let e = try #require(s.record(scanID: UUID(), summary: sum, text: "x", mode: .localOnly))
        #expect(e.decision == sum.decision)
    }

    @Test func samplesAndDisabledHistoryAreNotRecorded() {
        let s = HistoryStore(directory: tempDir(), defaults: defaults())
        #expect(s.record(scanID: UUID(), summary: summary(sample: true), text: "x", mode: .localOnly) == nil)
        s.isEnabled = false
        #expect(s.record(scanID: UUID(), summary: summary(), text: "x", mode: .localOnly) == nil)
        #expect(s.entries.isEmpty)
    }

    @Test func corruptFileIsSetAsideAndHistoryStillWorks() throws {
        let dir = tempDir()
        try Data("{not json".utf8).write(to: dir.appendingPathComponent("history.json"))
        let s = HistoryStore(directory: dir, defaults: defaults())
        #expect(s.entries.isEmpty)
        #expect(s.lastError != nil)
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(names.contains { $0.hasPrefix("history.corrupt-") })
        #expect(s.record(scanID: UUID(), summary: summary(), text: "x", mode: .localOnly) != nil)
        #expect(s.lastError == nil)
    }

    @Test func storageFailureIsReportedButDoesNotThrow() throws {
        let parent = tempDir()
        let blocker = parent.appendingPathComponent("not-a-dir")
        try Data("x".utf8).write(to: blocker) // a FILE where the history directory should be
        let s = HistoryStore(directory: blocker, defaults: defaults())
        let e = s.record(scanID: UUID(), summary: summary(), text: "x", mode: .localOnly)
        #expect(e != nil)            // the scan result is still returned / shown
        #expect(s.lastError != nil)  // and the failure is visible in the History window
    }

    @Test func boundedByRetentionAndCount() async {
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let s = HistoryStore(directory: tempDir(), defaults: defaults(), now: { clock })
        s.retentionDays = 7
        s.record(scanID: UUID(), summary: summary(), text: "old", mode: .localOnly)
        clock += 8 * 86_400
        s.record(scanID: UUID(), summary: summary(), text: "new", mode: .localOnly)
        #expect(s.entries.count == 1)
        // ~500 synchronous file writes: yield the main actor between them so tests running in
        // parallel (e.g. EngineManager's time-limited startup) are not starved for seconds.
        for i in 0..<(HistoryStore.maxEntries + 5) {
            clock += 300
            s.record(scanID: UUID(), summary: summary(), text: "m\(i)", mode: .localOnly)
            await Task.yield()
        }
        #expect(s.entries.count == HistoryStore.maxEntries)
    }

    @Test func fileIsPrivateToTheUser() throws {
        let dir = tempDir()
        let s = HistoryStore(directory: dir, defaults: defaults())
        s.record(scanID: UUID(), summary: summary(), text: "x", mode: .localOnly)
        let perms = try FileManager.default.attributesOfItem(atPath: s.fileURL.path)[.posixPermissions] as? NSNumber
        #expect(perms?.intValue == 0o600)
    }

    @Test func remoteModeIsRecorded() throws {
        let s = HistoryStore(directory: tempDir(), defaults: defaults())
        let e = try #require(s.record(scanID: UUID(), summary: summary(remote: RemoteAnalysisInfo(requested: true, used: true, status: "ok", model: "m:free")), text: "x", mode: .remoteAssisted))
        #expect(e.analysisMode == .remoteAssisted && e.remoteUsed && e.source == "Checked on this device + AI second opinion.")
    }
}

@MainActor
@Suite("Phase 5 — local reports", .serialized)
struct ReportStoreTests {
    func entry(_ s: HistoryStore) throws -> HistoryEntry {
        try #require(s.record(scanID: UUID(), summary: summary(), text: scamText, mode: .localOnly))
    }

    @Test func storedLocallyWithoutContentAndDeduplicated() throws {
        let dir = tempDir()
        let h = HistoryStore(directory: dir, defaults: defaults())
        let r = ReportStore(directory: dir)
        let e = try entry(h)
        try r.submit(.correct, for: e)
        try r.submit(.falsePositive, for: e) // changing your mind replaces, no duplicate
        #expect(r.reports.count == 1)
        #expect(r.report(for: e.id)?.verdict == .falsePositive)
        #expect(r.reports[0].provenance == "local-user")
        let raw = try String(contentsOf: r.fileURL, encoding: .utf8)
        for secret in ["482913", "SECRET123", "KYC has expired", "ravi"] { #expect(!raw.contains(secret)) }
        #expect(ReportStore(directory: dir).reports.count == 1) // persisted
    }

    @Test func deleteAndRateLimit() throws {
        let dir = tempDir()
        let h = HistoryStore(directory: dir, defaults: defaults())
        let r = ReportStore(directory: dir)
        var made: [LocalReport] = []
        for i in 0..<ReportStore.maxPerDay {
            let e = try #require(h.record(scanID: UUID(), summary: summary(), text: "msg \(i)", mode: .localOnly))
            made.append(try r.submit(.unsure, for: e))
        }
        let extra = try #require(h.record(scanID: UUID(), summary: summary(), text: "one more", mode: .localOnly))
        #expect(throws: ReportStore.ReportError.rateLimited) { try r.submit(.correct, for: extra) }
        r.delete(made[0].id)
        #expect(r.reports.count == ReportStore.maxPerDay - 1)
        r.clearAll()
        #expect(ReportStore(directory: dir).reports.isEmpty)
    }
}

@Suite("Phase 5 — redaction")
struct RedactorTests {
    @Test func masksSensitivePatterns() {
        let r = Redactor.redact(scamText + " key sk-or-v1-abcdef0123456789 Bearer abc.def.ghi card 4111 1111 1111 1234")
        for secret in ["482913", "SECRET123", "ravi.kumar", "ravi@okaxis", "98765", "/verify", "sk-or-v1-abcdef", "abc.def.ghi", "4111 1111"] {
            #expect(!r.contains(secret), "\(secret) leaked: \(r)")
        }
        #expect(r.contains("https://sbi-kyc-update.xyz/…"))
        #expect(r.contains("KYC has expired"))
    }
}

struct HistoryDisplaySourceTests {
    @Test func olderEntriesAreShownInCurrentWording() {
        let old = HistoryEntry(id: UUID(), scanID: UUID(), date: Date(), riskLevel: .high, riskScore: 70, categoryLabel: nil,
                               headline: "h", reasons: [], source: "Checked on this Mac + remote AI (vendor/model:free).",
                               analysisMode: .remoteAssisted, remoteUsed: true, linkHosts: [], excerpt: nil, text: nil, decision: nil,
                               contentDigest: "x", captureMode: nil, failure: nil)
        #expect(old.displaySource == "Checked on this device + AI second opinion.")
        #expect(!old.displaySource.contains("free") && !old.displaySource.contains("Mac"))
    }
}
