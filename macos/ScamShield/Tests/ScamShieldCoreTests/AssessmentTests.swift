import Foundation
import Testing
@testable import ScamShieldCore

/// A result from an incomplete check ("insufficient": a detector failed and nothing suspicious was
/// found) is shown as "Unable to assess" — never as the green safe card.
actor AssessmentAPI: ScamShieldAPI {
    let summary: AnalysisSummary
    init(_ s: AnalysisSummary) { summary = s }
    func scanMessage(_ text: String) async throws -> AnalysisSummary { summary }
    func analyzeURL(_ url: String) async throws -> AnalysisSummary { summary }
    func healthCheck() async throws -> BackendHealth { BackendHealth(status: "ok", checks: [:], appVersion: nil) }
}

@MainActor
struct AssessmentTests {
    private func summary(level: RiskLevel, assessment: AssessmentInfo?) -> AnalysisSummary {
        var s = AnalysisSummary(classification: level == .safe ? .safe : .scam, riskLevel: level, riskScore: level == .safe ? 4 : 88,
                                confidence: 0.5, category: "other", categoryLabel: "Other")
        s.assessment = assessment
        return s
    }
    private func scan(_ s: AnalysisSummary) async -> ScannerPhase {
        let c = ScannerCoordinator(minimumStageDuration: .zero, textReadyHold: .zero, sleep: { _ in })
        let d = ScannerDependencies(permission: FakePermission(.granted), targets: FakeTargets(region: nil), capturer: CaptureSpy(),
                                    recognizer: FakeOCR(text: "Hello, your parcel ships tomorrow."), api: AssessmentAPI(s), analysisGate: nil)
        c.start(.fullScreen, with: d)
        await c.waitUntilFinished()
        return c.phase
    }

    @Test func decodesTheServiceAssessment() throws {
        let json = #"{"classification":"safe","riskLevel":"safe","riskScore":3,"confidence":0.4,"category":"other","categoryLabel":"Other","assessment":{"status":"insufficient","reasons":["the local ML model was unavailable and no AI second opinion was available"]}}"#
        let s = try JSONDecoder().decode(AnalysisSummary.self, from: Data(json.utf8))
        #expect(s.assessmentGaps == ["the local ML model was unavailable and no AI second opinion was available"])
    }

    @Test func insufficientSafeIsUnableToAssessNotGreen() async {
        let phase = await scan(summary(level: .safe, assessment: AssessmentInfo(status: "insufficient", reasons: ["the local ML model was unavailable"])))
        guard case .failed(let f) = phase else { Issue.record("expected Unable to assess, got \(phase)"); return }
        #expect(f.title == "Unable to assess")
        #expect(f.message.contains("not a safe verdict"))
    }

    @Test func completeSafeIsGreen() async {
        let phase = await scan(summary(level: .safe, assessment: AssessmentInfo(status: "complete", reasons: [])))
        guard case .safe = phase else { Issue.record("expected safe, got \(phase)"); return }
    }

    @Test func warningsAreShownEvenWhenADetectorFailed() async {
        // Rules found a scam while ML was down: the warning still matters.
        let phase = await scan(summary(level: .critical, assessment: AssessmentInfo(status: "complete", reasons: [])))
        #expect(phase.isResult)
    }
}
