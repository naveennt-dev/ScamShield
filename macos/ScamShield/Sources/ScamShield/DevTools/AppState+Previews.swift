#if SCAMSHIELD_DEVTOOLS
import AppKit
// Developer-only sample previews (development builds). They walk the real coordinator through every
// state with canned data and are never part of the released app.
import ScamShieldCore
import ScamShieldDevSupport

extension AppState {
    /// Self-test / scan-eval runs (scripted developer sessions).
    static let isDeveloperSession = ProcessInfo.processInfo.arguments.contains { $0 == "--self-test" || $0 == "--scan-eval" || $0 == "--ui-capture" }

    func preview(_ scenario: PreviewScenario) {
        guard !coordinator.phase.isBusy else { return }
        let api: any ScamShieldAPI
        switch scenario {
        case .safe: api = MockScamShieldAPI(scenario: .safe)
        case .suspicious: api = MockScamShieldAPI(scenario: .suspicious)
        case .critical: api = MockScamShieldAPI(scenario: .critical)
        default: api = MockScamShieldAPI(scenario: .failure)
        }
        let recognizer: any TextRecognizing = scenario == .noText ? EmptyRecognizer() : PreviewRecognizer()
        let deps = ScannerDependencies(
            permission: PreviewPermission(scenario == .permissionRequired ? .notRequested : .granted),
            targets: PreviewTargets(),
            capturer: PreviewCapture(),
            recognizer: recognizer,
            api: api,
            analysisGate: nil
        )
        previewRunning = true
        coordinator.start(.fullScreen, with: deps)
    }
}

/// Fixed full-display target used by previews (nothing is captured).
@MainActor
final class PreviewTargets: CaptureTargetSelecting {
    func currentDisplayTarget() -> CaptureTarget? {
        CaptureTarget(kind: .fullDisplay, displayID: 0, sourceRect: CGRect(x: 0, y: 0, width: 100, height: 100), pointPixelScale: 2)
    }
    func selectRegion() async -> CaptureTarget? { currentDisplayTarget() }
}

struct EmptyRecognizer: TextRecognizing {
    func recognizeText(in image: CapturedImage) async throws -> OCRResult {
        OCRResult(text: "", observations: [], confidence: 0)
    }
}
#endif
