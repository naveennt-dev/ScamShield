import Foundation
import Testing
@testable import ScamShieldCore

@MainActor
struct ContributionOutboxTests {
    private func tempDir() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)") }
    private func defaults() -> UserDefaults {
        let name = "outbox.test.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }
    private func entry(_ store: HistoryStore, level: RiskLevel = .safe) throws -> HistoryEntry {
        let s = AnalysisSummary(classification: level == .safe ? .safe : .scam, riskLevel: level, riskScore: level == .safe ? 8 : 88,
                                confidence: 0.8, category: "kyc", categoryLabel: "KYC Scam")
        return try #require(store.record(scanID: UUID(), summary: s, text: "Your KYC expired. Share OTP 482913 at sbi-kyc.top/verify now", mode: .localOnly))
    }

    @Test func offByDefaultQueuesNothing() throws {
        let dir = tempDir(), d = defaults()
        let o = ContributionOutbox(directory: dir, defaults: d)
        #expect(!o.isEnabled)
        #expect(!o.enqueue(.missedScam, for: try entry(HistoryStore(directory: dir, defaults: d))))
        #expect(o.pending.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: o.fileURL.path))
    }

    @Test func queuesMaskedTextWithVerdictAndReplacesOnChange() throws {
        let dir = tempDir(), d = defaults()
        let h = HistoryStore(directory: dir, defaults: d)
        let o = ContributionOutbox(directory: dir, defaults: d)
        o.isEnabled = true
        let e = try entry(h)
        #expect(o.enqueue(.missedScam, for: e))
        #expect(o.enqueue(.unsure, for: e)) // changed mind → one item
        #expect(o.pending.count == 1 && o.pending[0].verdict == "unsure")
        let p = o.pending[0]
        #expect(p.system.riskLevel == "safe" && p.system.category == "kyc")
        let body = String(decoding: try p.requestBody(), as: UTF8.self)
        for secret in ["482913", "/verify"] { #expect(!body.contains(secret)) }
        #expect(!body.contains(e.id.uuidString)) // no local identifiers sent
        let attrs = try FileManager.default.attributesOfItem(atPath: o.fileURL.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(ContributionOutbox(directory: dir, defaults: d).pending.count == 1) // persisted
    }

    @Test func nothingToShareWhenTextWasNotSaved() throws {
        let dir = tempDir(), d = defaults()
        let h = HistoryStore(directory: dir, defaults: d)
        h.saveText = false
        let o = ContributionOutbox(directory: dir, defaults: d)
        o.isEnabled = true
        #expect(!o.enqueue(.missedScam, for: try entry(h)))
    }

    @Test func flushRemovesAcceptedAndKeepsTheRest() async throws {
        let dir = tempDir(), d = defaults()
        let h = HistoryStore(directory: dir, defaults: d)
        let o = ContributionOutbox(directory: dir, defaults: d)
        o.isEnabled = true
        o.enqueue(.missedScam, for: try entry(h))
        o.enqueue(.correct, for: try entry(h, level: .critical))
        await o.flush { _ in .notAccepted(403) }
        #expect(o.pending.count == 2)
        #expect(o.lastStatus?.contains("isn't accepting") == true)
        await o.flush { _ in .accepted }
        #expect(o.pending.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: o.fileURL.path))
    }

    @Test func turningOffDeletesQueuedItems() throws {
        let dir = tempDir(), d = defaults()
        let o = ContributionOutbox(directory: dir, defaults: d)
        o.isEnabled = true
        o.enqueue(.missedScam, for: try entry(HistoryStore(directory: dir, defaults: d)))
        o.isEnabled = false
        #expect(o.pending.isEmpty)
    }

    @Test func installationIDIsRandomAndStable() {
        let d = defaults()
        let a = ContributionOutbox(directory: tempDir(), defaults: d).installationID
        #expect(UUID(uuidString: a) != nil)
        #expect(ContributionOutbox(directory: tempDir(), defaults: d).installationID == a)
        #expect(ContributionOutbox(directory: tempDir(), defaults: defaults()).installationID != a)
    }
}
