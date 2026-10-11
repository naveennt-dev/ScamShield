import Foundation
import Testing
@testable import ScamShieldCore

/// Corrective fixes (real-scan bugs): layout-aware OCR text, no "safe" fallbacks, History that
/// matches the card, accurate service status.

private func obs(_ text: String, x: CGFloat, top: CGFloat, w: CGFloat, h: CGFloat = 0.012) -> TextObservation {
    TextObservation(text: text, boundingBox: CGRect(x: x, y: 1 - top - h, width: w, height: h), confidence: 0.9)
}

@Suite("Corrective — full-screen OCR assembly")
struct ScreenAssemblyTests {
    @Test("a chat message is not interleaved with a desktop label on the same row")
    func noInterleaving() {
        // Message lines in a window on the left; a file label far to the right on line 1's row.
        let r = TextAssembler.assemble([
            obs("Sir aapka bijli connection aaj raat kaat diya jayega kyunki pichle mahine ka bill", x: 0.05, top: 0.40, w: 0.45),
            obs("update nahi hua hai. Turant call karein aur OTP batayein", x: 0.05, top: 0.414, w: 0.33),
            obs("Certificate.pdf", x: 0.90, top: 0.40, w: 0.07),
        ], imageAspect: 1.54)
        #expect(r.text.contains("mahine ka bill\nupdate nahi hua hai"))
        #expect(!r.text.contains("bill Certificate.pdf"))
        #expect(r.text.contains("\n\nCertificate.pdf") || r.text.hasPrefix("Certificate.pdf"))
    }

    @Test("side-by-side columns become separate blocks, each read top to bottom")
    func columns() {
        let r = TextAssembler.assemble([
            obs("Left one", x: 0.05, top: 0.20, w: 0.2), obs("Right one", x: 0.60, top: 0.20, w: 0.2),
            obs("Left two", x: 0.05, top: 0.214, w: 0.2), obs("Right two", x: 0.60, top: 0.214, w: 0.2),
        ], imageAspect: 1.6)
        #expect(r.text == "Left one\nLeft two\n\nRight one\nRight two")
    }

    @Test("a single region (one block) reads exactly as before")
    func singleBlockUnchanged() {
        let r = TextAssembler.assemble([obs("Dear customer, share the", x: 0.1, top: 0.1, w: 0.5, h: 0.05), obs("OTP now.", x: 0.1, top: 0.16, w: 0.2, h: 0.05)])
        #expect(r.text == "Dear customer, share the\nOTP now.")
    }

    @Test("empty OCR stays empty (it becomes 'No readable text', never a result)")
    func emptyOCR() {
        #expect(TextAssembler.assemble([]).text.isEmpty)
        #expect(TextValidation.prepare("   \n ") == nil)
    }
}

@Suite("Corrective — evidence-based result card")
struct EvidenceCardTests {
    func summary(_ level: RiskLevel, score: Int, reasons: [String], warnings: [String] = []) -> AnalysisSummary {
        AnalysisSummary(classification: level == .safe ? .safe : .scam, riskLevel: level, riskScore: score, confidence: 0.7,
                        category: "other", categoryLabel: "Other", reasons: reasons, warnings: warnings)
    }

    @Test("a safe card shows the real score and the engine's real findings")
    func safeShowsEvidence() {
        let p = ResultPresentation(summary: summary(.safe, score: 19, reasons: ["Creates urgency to stop you from thinking it through."]))
        #expect(p.tone == .safe)
        #expect(p.riskScore == 19)
        #expect(p.reasons == ["Creates urgency to stop you from thinking it through."])
        // Weak signs present → not presented as a clean bill.
        #expect(p.headline == "Low risk — a few weak signs")
        #expect(!p.detail.contains("Nothing concerning"))
    }

    @Test("only a genuinely clean result says 'No suspicious content detected'", arguments: [
        (3, ["No known scam indicators were found."], "No suspicious content detected"),
        (29, ["No known scam indicators were found."], "Low risk — a few weak signs"),   // e.g. ML 50/50, no rules
        (8, ["Creates urgency to stop you from thinking it through."], "Low risk — a few weak signs"),
    ])
    func cleanOnlyWhenClean(score: Int, reasons: [String], headline: String) {
        #expect(ResultPresentation(summary: summary(.safe, score: score, reasons: reasons)).headline == headline)
    }

    @Test("an unavailable ML model is disclosed on a safe card (limited check, not a clean bill)")
    func mlUnavailableDisclosed() {
        let p = ResultPresentation(summary: summary(.safe, score: 0, reasons: ["No known scam indicators were found."],
                                                    warnings: ["The ML classifier was unavailable; result is based on the safety rules and link checks."]))
        #expect(p.detail.contains("limited check"))
        #expect(p.notes.contains { $0.contains("ML classifier was unavailable") })
    }

    @Test("the card shows the result it was given — no fixed or stale category", arguments: [RiskLevel.safe, .suspicious, .high, .critical])
    func cardFollowsResult(level: RiskLevel) {
        let p = ResultPresentation(summary: summary(level, score: level == .safe ? 5 : 70, reasons: ["r"]))
        let expected: ResultPresentation.Tone = level == .safe ? .safe : level == .suspicious ? .caution : .danger
        #expect(p.tone == expected)
        #expect(p.riskScore == (level == .safe ? 5 : 70))
    }
}

@MainActor
@Suite("Corrective — History matches the scan", .serialized)
struct HistoryConsistencyTests {
    func store() -> HistoryStore {
        let n = "scamshield.history.tests.\(UUID().uuidString)"
        return HistoryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), defaults: UserDefaults(suiteName: n)!)
    }

    @Test func recordsCaptureModeScoreAndReasonsOfThatScan() throws {
        let s = store(), id = UUID()
        let summary = AnalysisSummary(classification: .scam, riskLevel: .high, riskScore: 72, confidence: 0.8, category: "credential_theft",
                                      categoryLabel: "OTP Fraud", reasons: ["Asks you to share a one-time password (OTP)."])
        let e = try #require(s.record(scanID: id, summary: summary, text: "x", mode: .localOnly, captureMode: .region))
        #expect(e.scanID == id && e.riskLevel == .high && e.riskScore == 72 && e.captureMode == .region && e.completed)
        #expect(e.reasons == summary.reasons)
    }

    @Test func failedScanIsRecordedAsNotAssessedNeverSafe() throws {
        let s = store()
        let e = try #require(s.recordFailure(scanID: UUID(), reason: "No readable text detected", mode: .localOnly, captureMode: .fullScreen))
        #expect(e.riskLevel == nil && e.riskScore == nil && !e.completed)
        #expect(e.headline == "Unable to assess")
        let r = ReportStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        #expect(throws: ReportStore.ReportError.notAssessed) { try r.submit(.correct, for: e) }
    }

    @Test func olderEntriesWithoutNewFieldsStillLoad() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let old = #"[{"id":"\#(UUID())","scanID":"\#(UUID())","date":"2026-10-10T13:07:03Z","riskLevel":"safe","riskScore":3,"headline":"No suspicious content detected","reasons":["No known scam indicators were found."],"source":"Checked on this Mac only.","analysisMode":"local","remoteUsed":false,"linkHosts":[],"contentDigest":"ab"}]"#
        try Data(old.utf8).write(to: dir.appendingPathComponent("history.json"))
        let s = HistoryStore(directory: dir, defaults: UserDefaults(suiteName: "scamshield.history.tests.\(UUID())")!, now: { ISO8601DateFormatter().date(from: "2026-10-11T00:00:00Z")! })
        #expect(s.entries.count == 1)
        #expect(s.entries[0].captureMode == nil && s.entries[0].completed && s.lastError == nil)
    }

    @Test("report verdicts make sense for the result: safe → missed scam, warning → false alarm")
    func verdictOptions() {
        // Four-option feedback: correct / missed scam / false positive / unsure.
        #expect(LocalReport.Verdict.options(for: .safe) == [.correct, .missedScam, .unsure])
        #expect(LocalReport.Verdict.options(for: .high) == [.correct, .falsePositive, .unsure])
        #expect(LocalReport.Verdict.options(for: nil).isEmpty)
        #expect(LocalReport.Verdict.falsePositive.title(for: .high).contains("False alarm"))
        #expect(LocalReport.Verdict.correct.title(for: .safe).contains("genuine"))
    }
}

@MainActor
@Suite("Corrective — accurate service status")
struct ServiceStatusTests {
    struct Failing: ScamShieldAPI {
        let error: ScamShieldAPIError
        func scanMessage(_ text: String) async throws -> AnalysisSummary { throw error }
        func analyzeURL(_ url: String) async throws -> AnalysisSummary { throw error }
        func healthCheck() async throws -> BackendHealth { throw error }
    }

    @Test("each failure gets its own accurate message, with the address and the fix", arguments: [
        (ScamShieldAPIError.backendUnreachable, "Nothing is answering at http://127.0.0.1:3000"),
        (.timedOut, "is running but didn't answer in time"),
        (.invalidResponse, "isn't the ScamShield service"),
    ])
    func messages(error: ScamShieldAPIError, expected: String) async {
        let s = SettingsStore(defaults: UserDefaults(suiteName: "scamshield.tests.\(UUID())")!, environment: [:], infoDictionary: [:], apiFactory: { _ in Failing(error: error) })
        await s.testConnection()
        guard case .offline(let msg) = s.connection else { Issue.record("expected offline"); return }
        #expect(msg.contains(expected), "\(msg)")
        #expect(s.lastChecked != nil)
    }
}

@Suite("Feedback migration")
struct FeedbackMigrationTests {
    @MainActor @Test func reportsSavedWithOldVerdictsStillLoad() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fb-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let old = """
        [{"id":"\(UUID())","historyEntryID":"\(UUID())","verdict":"scam","date":"2026-10-08T10:00:00Z","riskLevel":"safe","riskScore":5,"linkHosts":[],"provenance":"local-user"},
         {"id":"\(UUID())","historyEntryID":"\(UUID())","verdict":"suspicious","date":"2026-10-08T10:00:00Z","riskLevel":"high","riskScore":70,"linkHosts":[],"provenance":"local-user"},
         {"id":"\(UUID())","historyEntryID":"\(UUID())","verdict":"false_positive","date":"2026-10-08T10:00:00Z","riskLevel":"high","riskScore":70,"linkHosts":[],"provenance":"local-user"},
         {"id":"\(UUID())","historyEntryID":"\(UUID())","verdict":"false_positive","date":"2026-10-08T10:00:00Z","riskLevel":"safe","riskScore":4,"linkHosts":[],"provenance":"local-user"}]
        """
        try old.write(to: dir.appendingPathComponent("reports.json"), atomically: true, encoding: .utf8)
        let r = ReportStore(directory: dir)
        #expect(r.lastError == nil)
        // The old "got it wrong" on a green result meant a missed scam.
        #expect(r.reports.map(\.verdict) == [.missedScam, .correct, .falsePositive, .missedScam])
    }
}
