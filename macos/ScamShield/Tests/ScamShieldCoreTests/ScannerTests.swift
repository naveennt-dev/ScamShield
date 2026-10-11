import CoreGraphics
import Foundation
import Testing
@testable import ScamShieldCore
import ScamShieldDevSupport

private let critical = try! MockScamShieldAPI.sample(for: .critical)
private let safe = try! MockScamShieldAPI.sample(for: .safe)
private let summary = ExtractedTextSummary(lineCount: 1, characterCount: 5, urlCount: 0, confidence: 1, wasTruncated: false, preview: "hello")

@Suite("Scanner state machine")
struct ScannerMachineTests {
    @Test("region flow: idle → requestingPermission → selectingRegion → capturing → processingOCR → textReady → sendingForAnalysis → result")
    func regionFlow() {
        var p = ScannerPhase.idle
        for (event, expected) in [
            (ScannerEvent.start(.region), ScannerPhase.requestingPermission(.region)),
            (.permissionGranted, .selectingRegion),
            (.regionSelected, .capturing(.region)),
            (.captured, .processingOCR),
            (.textRecognized(summary), .textReady(summary)),
            (.submitted, .sendingForAnalysis),
            (.analyzed(critical), .suspicious(ResultPresentation(summary: critical))),
            (.dismiss, .idle),
        ] {
            p = ScannerMachine.reduce(p, event)!
            #expect(p == expected)
        }
    }

    @Test func fullScreenSkipsSelection() {
        #expect(ScannerMachine.reduce(.requestingPermission(.fullScreen), .permissionGranted) == .capturing(.fullScreen))
        #expect(ScannerMachine.reduce(.sendingForAnalysis, .analyzed(safe)) == .safe(ResultPresentation(summary: safe)))
    }

    @Test("every working state can fail or be cancelled", arguments: [
        ScannerPhase.requestingPermission(.fullScreen), .selectingRegion, .capturing(.region), .processingOCR, .textReady(summary), .sendingForAnalysis,
    ])
    func failAndCancel(phase: ScannerPhase) {
        #expect(ScannerMachine.reduce(phase, .failed(.ocrFailed)) == .failed(.ocrFailed))
        #expect(ScannerMachine.reduce(phase, .cancel) == .cancelled)
    }

    @Test("invalid transitions are rejected", arguments: [
        (ScannerPhase.idle, ScannerEvent.captured),
        (.idle, .failed(.captureFailed)),
        (.idle, .cancel),
        (.selectingRegion, .captured),
        (.capturing(.fullScreen), .start(.region)),
        (.processingOCR, .analyzed(safe)),
        (.textReady(summary), .analyzed(safe)),
        (.sendingForAnalysis, .regionSelected),
        (.safe(ResultPresentation(summary: safe)), .failed(.ocrFailed)),
        (.failed(.ocrFailed), .captured),
    ])
    func invalid(phase: ScannerPhase, event: ScannerEvent) {
        #expect(ScannerMachine.reduce(phase, event) == nil)
    }

    @Test func stagesAreOrderedAndHonest() {
        #expect(ScannerPhase.capturing(.region).stage == .capturing)
        #expect(ScannerPhase.processingOCR.stage == .readingText)
        #expect(ScannerPhase.textReady(summary).stage == .preparingAnalysis)
        #expect(ScannerPhase.sendingForAnalysis.stage == .analyzing)
        #expect(ScannerPhase.idle.stage == nil)
        #expect(ScanStage.allCases.map(\.label) == ["Capturing screen", "Reading text", "Preparing analysis", "Analyzing"])
    }

    @Test("failure copy matches the specification and never exposes internals")
    func failureCopy() {
        #expect(ScannerFailure.permissionRequired.title == "Screen Recording Permission Required")
        #expect(ScannerFailure.permissionRequired.message.contains("does not continuously monitor"))
        #expect(ScannerFailure.permissionDenied.title == "Screen access unavailable")
        #expect(ScannerFailure.noTextDetected.title == "No readable text detected")
        #expect(ScannerFailure.ocrFailed.title == "Couldn't read this content")
        #expect(ScannerFailure.captureFailed.title == "Couldn't capture the selected area.")
        #expect(ScannerFailure.analysisServiceUnavailable.title == "ScamShield analysis service isn't running.")
        #expect(ScannerFailure.permissionDenied.opensSystemSettings && ScannerFailure.permissionRequired.opensSystemSettings)
        #expect(!ScannerFailure.noTextDetected.opensSystemSettings)
    }
}

@Suite("Result presentation wording")
struct PresentationTests {
    @Test func wording() throws {
        #expect(ResultPresentation(summary: safe).headline == "No suspicious content detected")
        #expect(ResultPresentation(summary: safe).detail == "Nothing concerning was identified.")
        // Corrective fix: a safe card shows the engine's real findings (why it is safe), not nothing.
        #expect(ResultPresentation(summary: safe).reasons == safe.reasons)
        #expect(ResultPresentation(summary: safe).riskScore == safe.riskScore)
        let s = ResultPresentation(summary: try MockScamShieldAPI.sample(for: .suspicious))
        #expect(s.tone == .caution && s.headline == "Suspicious Content" && s.riskScore == 78 && s.categoryLabel == "Possible Phishing")
        #expect(s.reasons == ["Urgent action requested.", "External link detected.", "Account-related pressure."])
        let c = ResultPresentation(summary: critical)
        #expect(c.tone == .danger && c.headline == "HIGH RISK SCAM" && c.primaryAdvice == "Do not click the link.")
        #expect(c.actions == ["Do not click the link.", "Do not share OTP, PIN or CVV."])
    }

    @Test("reasons and actions are capped for a compact card")
    func capped() {
        let many = AnalysisSummary(classification: .scam, riskLevel: .high, riskScore: 80, confidence: 0.9, category: "kyc", categoryLabel: "KYC Scam",
                                   reasons: ["a", "b", "c", "d", "e"], recommendedActions: ["x", "y", "z"])
        let p = ResultPresentation(summary: many)
        #expect(p.reasons == ["a", "b", "c"] && p.actions == ["x", "y"])
    }

    @Test func scoresAreClamped() {
        let s = AnalysisSummary(classification: .scam, riskLevel: .critical, riskScore: 150, confidence: 3, category: "kyc", categoryLabel: "KYC")
        #expect(s.riskScore == 100 && s.confidence == 1)
    }
}

// MARK: - Coordinator with fakes

@MainActor
final class FakePermission: ScreenCapturePermissionProviding {
    var current: ScreenCapturePermissionStatus
    var requests = 0
    init(_ s: ScreenCapturePermissionStatus) { current = s }
    func status() -> ScreenCapturePermissionStatus { current }
    func request() -> ScreenCapturePermissionStatus { requests += 1; return current == .notRequested ? .promptShown : current }
}

@MainActor
final class FakeTargets: CaptureTargetSelecting {
    var region: CaptureTarget?
    var display: CaptureTarget? = CaptureTarget(kind: .fullDisplay, displayID: 1, sourceRect: CGRect(x: 0, y: 0, width: 100, height: 100), pointPixelScale: 2)
    init(region: CaptureTarget?) { self.region = region }
    func currentDisplayTarget() -> CaptureTarget? { display }
    func selectRegion() async -> CaptureTarget? { region }
}

actor CaptureSpy: ScreenCapturing {
    private(set) var targets: [CaptureTarget] = []
    let error: CaptureError?
    init(error: CaptureError? = nil) { self.error = error }
    func capture(_ target: CaptureTarget) async throws -> CapturedImage {
        targets.append(target)
        if let error { throw error }
        let ctx = CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return CapturedImage(cgImage: ctx.makeImage()!, target: target)
    }
}

struct FakeOCR: TextRecognizing {
    var text: String
    var fails = false
    func recognizeText(in image: CapturedImage) async throws -> OCRResult {
        if fails { throw OCRError.recognitionFailed }
        return OCRResult(text: text, observations: [], confidence: 0.9)
    }
}

actor APISpy: ScamShieldAPI {
    private(set) var received: [String] = []
    let result: Result<AnalysisSummary, ScamShieldAPIError>
    init(_ r: Result<AnalysisSummary, ScamShieldAPIError>) { result = r }
    func scanMessage(_ text: String) async throws -> AnalysisSummary { received.append(text); return try result.get() }
    func analyzeURL(_ url: String) async throws -> AnalysisSummary { try result.get() }
    func healthCheck() async throws -> BackendHealth { BackendHealth(status: "ok", checks: ["llm": "not_configured"], appVersion: nil) }
}

struct FailingGate: AnalysisGate {
    func verify() async throws { throw ScannerFailure.cloudAnalysisEnabled }
}

@MainActor
@Suite("Scanner coordinator")
struct CoordinatorTests {
    let region = CaptureTarget(kind: .region, displayID: 2, sourceRect: CGRect(x: 10, y: 20, width: 300, height: 120), pointPixelScale: 2)

    func make() -> ScannerCoordinator { ScannerCoordinator(minimumStageDuration: .zero, textReadyHold: .zero, sleep: { _ in }) }

    func deps(
        permission: ScreenCapturePermissionStatus = .granted,
        region: CaptureTarget? = nil,
        capture: CaptureSpy = CaptureSpy(),
        ocr: FakeOCR = FakeOCR(text: "Your KYC has expired.\nhttps://x.example/verify"),
        api: APISpy = APISpy(.success(try! MockScamShieldAPI.sample(for: .critical))),
        gate: (any AnalysisGate)? = nil
    ) -> ScannerDependencies {
        ScannerDependencies(permission: FakePermission(permission), targets: FakeTargets(region: region), capturer: capture, recognizer: ocr, api: api, analysisGate: gate)
    }

    @Test("region scan captures ONLY the selected region and sends the OCR text to the local API")
    func regionScan() async {
        let c = make(), cap = CaptureSpy(), api = APISpy(.success(critical))
        var phases: [ScannerPhase] = []
        c.onPhaseChange = { phases.append($0) }
        c.start(.region, with: deps(region: region, capture: cap, api: api))
        await c.waitUntilFinished()
        #expect(await cap.targets == [region])
        #expect(await api.received == ["Your KYC has expired.\nhttps://x.example/verify"])
        let names = phases.map { p -> String in
            switch p {
            case .requestingPermission: return "permission"
            case .selectingRegion: return "selecting"
            case .capturing: return "capturing"
            case .processingOCR: return "ocr"
            case .textReady: return "text"
            case .sendingForAnalysis: return "sending"
            case .suspicious: return "suspicious"
            default: return "other"
            }
        }
        #expect(names == ["permission", "selecting", "capturing", "ocr", "text", "sending", "suspicious"])
        if case .suspicious(let p) = c.phase { #expect(p.tone == .danger) } else { Issue.record("\(c.phase)") }
    }

    @Test("full-screen scan captures the current display")
    func fullScreen() async {
        let c = make(), cap = CaptureSpy()
        c.start(.fullScreen, with: deps(capture: cap))
        await c.waitUntilFinished()
        #expect(await cap.targets.first?.kind == .fullDisplay)
    }

    @Test("cancelled selection: nothing captured, nothing sent")
    func cancelledSelection() async {
        let c = make(), cap = CaptureSpy(), api = APISpy(.success(safe))
        c.start(.region, with: deps(region: nil, capture: cap, api: api))
        await c.waitUntilFinished()
        #expect(c.phase == .cancelled)
        #expect(await cap.targets.isEmpty)
        #expect(await api.received.isEmpty)
    }

    @Test("permission: granted / never asked (prompt once) / denied / revoked")
    func permissions() async {
        let c = make()
        let asked = FakePermission(.notRequested)
        let cap = CaptureSpy()
        c.start(.fullScreen, with: ScannerDependencies(permission: asked, targets: FakeTargets(region: nil), capturer: cap, recognizer: FakeOCR(text: "x"), api: APISpy(.success(safe)), analysisGate: nil))
        await c.waitUntilFinished()
        #expect(c.phase == .failed(.permissionRequired))
        #expect(asked.requests == 1)

        c.start(.fullScreen, with: deps(permission: .denied, capture: cap))
        await c.waitUntilFinished()
        #expect(c.phase == .failed(.permissionDenied))
        #expect(await cap.targets.isEmpty)

        // Revoked between the check and the capture: ScreenCaptureKit reports userDeclined.
        c.start(.fullScreen, with: deps(capture: CaptureSpy(error: .permissionDenied)))
        await c.waitUntilFinished()
        #expect(c.phase == .failed(.permissionDenied))
    }

    @Test("failure mapping", arguments: [
        ("capture", ScannerFailure.captureFailed),
        ("ocr", .ocrFailed),
        ("empty", .noTextDetected),
        ("symbols", .noTextDetected),
        ("down", .analysisServiceUnavailable),
        ("timeout", .analysisFailed("The local ScamShield service took too long to respond. Try again.")) /* Phase 6: a slow service is not "not running" */,
        ("gate", .cloudAnalysisEnabled),
    ])
    func failures(kind: String, expected: ScannerFailure) async {
        let c = make()
        var d = deps()
        switch kind {
        case "capture": d.capturer = CaptureSpy(error: .failed)
        case "ocr": d.recognizer = FakeOCR(text: "", fails: true)
        case "empty": d.recognizer = FakeOCR(text: "   \n\t ")
        case "symbols": d.recognizer = FakeOCR(text: "— · • ···")
        case "down": d.api = APISpy(.failure(.backendUnreachable))
        case "timeout": d.api = APISpy(.failure(.timedOut))
        case "gate": d.analysisGate = FailingGate()
        default: break
        }
        c.start(.fullScreen, with: d)
        await c.waitUntilFinished()
        #expect(c.phase == .failed(expected))
    }

    @Test("cloud gate blocks sending: the API never sees the text")
    func gateBlocks() async {
        let c = make(), api = APISpy(.success(safe))
        c.start(.fullScreen, with: deps(api: api, gate: FailingGate()))
        await c.waitUntilFinished()
        #expect(await api.received.isEmpty)
    }

    @Test("text is validated before sending (controls stripped, length capped)")
    func validatedBeforeSending() async {
        let c = make(), api = APISpy(.success(safe))
        let raw = "Pay now\u{202E}\u{0007} " + String(repeating: "a", count: 20_000)
        c.start(.fullScreen, with: deps(ocr: FakeOCR(text: raw), api: api))
        await c.waitUntilFinished()
        let sent = await api.received.first ?? ""
        #expect(sent.count == TextValidation.maxCharacters)
        #expect(!sent.unicodeScalars.contains { $0.value == 0x202E || $0.value == 0x07 })
    }

    @Test("a second start while busy is ignored; dismiss returns to idle")
    func busy() async {
        let c = ScannerCoordinator(minimumStageDuration: .seconds(5), textReadyHold: .zero)
        #expect(c.start(.fullScreen, with: deps()))
        #expect(!c.start(.region, with: deps()))
        c.dismiss()
        await c.waitUntilFinished()
        #expect(c.phase == .idle)
    }
}

@MainActor
@Suite("Screen capture permission")
struct PermissionTests {
    func defaults() -> UserDefaults {
        let n = "perm.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: n)!
        d.removePersistentDomain(forName: n)
        return d
    }

    @Test func grantedNeverPrompts() {
        var prompts = 0
        let p = ScreenCapturePermission(defaults: defaults(), preflight: { true }, requestAccess: { prompts += 1; return true })
        #expect(p.status() == .granted)
        #expect(p.request() == .granted)
        #expect(prompts == 0)
    }

    @Test("prompts at most once, then points to System Settings")
    func promptsOnce() {
        var prompts = 0
        let d = defaults()
        let p = ScreenCapturePermission(defaults: d, preflight: { false }, requestAccess: { prompts += 1; return false })
        #expect(p.status() == .notRequested)
        #expect(p.request() == .promptShown)
        #expect(p.status() == .denied)
        #expect(p.request() == .denied)
        #expect(ScreenCapturePermission(defaults: d, preflight: { false }, requestAccess: { prompts += 1; return false }).request() == .denied)
        #expect(prompts == 1)
    }

    @Test("revocation is detected on the next scan")
    func revoked() {
        var granted = true
        let p = ScreenCapturePermission(defaults: defaults(), preflight: { granted }, requestAccess: { false })
        #expect(p.status() == .granted)
        granted = false
        #expect(p.status() != .granted)
    }

    @Test func settingsURLTargetsScreenRecordingPane() {
        #expect(ScreenCapturePermission.settingsURL.absoluteString.contains("Privacy_ScreenCapture"))
    }
}

@Suite("Local-only gate")
struct LocalOnlyGuardTests {
    struct HealthAPI: ScamShieldAPI {
        let health: Result<BackendHealth, ScamShieldAPIError>
        func scanMessage(_ text: String) async throws -> AnalysisSummary { throw ScamShieldAPIError.invalidResponse }
        func analyzeURL(_ url: String) async throws -> AnalysisSummary { throw ScamShieldAPIError.invalidResponse }
        func healthCheck() async throws -> BackendHealth { try health.get() }
    }

    @Test("local-only mode: allows only a backend whose remote AI is off or opt-in only", arguments: [
        ("not_configured", true), ("disabled", true), ("opt_in", true), ("ok", false), ("unknown", false),
    ])
    func llmStates(llm: String, allowed: Bool) async {
        let gate = LocalOnlyGuard(api: HealthAPI(health: .success(BackendHealth(status: "degraded", checks: ["llm": llm], appVersion: nil))))
        do {
            try await gate.verify()
            #expect(allowed)
        } catch {
            #expect(!allowed)
            #expect(error as? ScannerFailure == .cloudAnalysisEnabled)
        }
    }

    @Test("remote-assisted mode (user consented): any reachable backend is accepted", arguments: ["ok", "opt_in", "disabled", "not_configured"])
    func remoteMode(llm: String) async throws {
        let gate = LocalOnlyGuard(api: HealthAPI(health: .success(BackendHealth(status: "ok", checks: ["llm": llm], appVersion: nil))), mode: .remoteAssisted)
        try await gate.verify()
    }

    @Test func unreachableOrDown() async {
        for health in [Result<BackendHealth, ScamShieldAPIError>.failure(.backendUnreachable), .success(BackendHealth(status: "down", checks: ["llm": "disabled"], appVersion: nil))] {
            await #expect(throws: ScannerFailure.analysisServiceUnavailable) { try await LocalOnlyGuard(api: HealthAPI(health: health)).verify() }
        }
    }
}

@Suite("Phase 4 — analysis mode & result source")
struct AnalysisModeTests {
    // Requirement change (shared-intelligence spec): AI-assisted is the default for new installs, but
    // only after consent. Environment/plist can still never switch remote analysis on.
    @Test func nothingIsRemoteWithoutConsentAndOnlySettingsCanChangeIt() {
        let name = "scamshield.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        defer { d.removePersistentDomain(forName: name) }
        #expect(ConfigurationLoader.load(environment: ["SCAMSHIELD_ANALYSIS_MODE": "remote-assisted"], defaults: d, infoDictionary: ["ScamShieldAnalysisMode": "remote-assisted"]).configuration.effectiveAnalysisMode == .localOnly)
        d.set("remote-assisted", forKey: ConfigurationKeys.defaultsAnalysisMode)
        #expect(ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: [:]).configuration.effectiveAnalysisMode == .localOnly) // no consent yet
        d.set(true, forKey: ConfigurationKeys.defaultsRemoteConsent)
        #expect(ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: [:]).configuration.effectiveAnalysisMode == .remoteAssisted)
        d.set("local", forKey: ConfigurationKeys.defaultsAnalysisMode)
        #expect(ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: [:]).configuration.effectiveAnalysisMode == .localOnly)
    }

    @MainActor @Test func settingsStorePersistsTheChoice() {
        let name = "scamshield.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        defer { d.removePersistentDomain(forName: name) }
        let s = SettingsStore(defaults: d, environment: [:], infoDictionary: [:])
        #expect(s.configuration.effectiveAnalysisMode == .localOnly)
        s.setAnalysisMode(.remoteAssisted) // an explicit choice in Settings counts as consent
        #expect(SettingsStore(defaults: d, environment: [:], infoDictionary: [:]).configuration.effectiveAnalysisMode == .remoteAssisted)
        s.setAnalysisMode(.localOnly)
        #expect(SettingsStore(defaults: d, environment: [:], infoDictionary: [:]).configuration.effectiveAnalysisMode == .localOnly)
    }

    func summary(_ remote: RemoteAnalysisInfo?, sample: Bool = false) -> AnalysisSummary {
        AnalysisSummary(classification: .scam, riskLevel: .critical, riskScore: 90, confidence: 0.8, category: "kyc", categoryLabel: "KYC Scam", isSample: sample, remote: remote)
    }

    @Test("result card says where the result came from", arguments: [
        (nil as RemoteAnalysisInfo?, "Checked on this device only."),
        (RemoteAnalysisInfo(requested: false, used: false, status: "not_requested"), "Checked on this device only."),
        // The model id (which may end in ":free") is never shown.
        (RemoteAnalysisInfo(requested: true, used: true, status: "ok", model: "m:free"), "Checked on this device + AI second opinion."),
        (RemoteAnalysisInfo(requested: true, used: false, status: "unavailable", reason: "TIMEOUT"), "AI second opinion not used (it timed out) — on-device result."),
        (RemoteAnalysisInfo(requested: true, used: false, status: "unavailable", reason: "RATE_LIMITED"), "AI second opinion not used (the AI is busy (rate limited)) — on-device result."),
        (RemoteAnalysisInfo(requested: true, used: false, status: "disabled_on_server"), "AI second opinion not used (it's turned off in the local service) — on-device result."),
        (RemoteAnalysisInfo(requested: true, used: false, status: "ignored", reason: "DISCARDED_BY_SAFETY_GUARD"), "AI second opinion not used (its answer was set aside by safety checks) — on-device result."),
    ])
    func sourceLine(remote: RemoteAnalysisInfo?, expected: String) {
        #expect(ResultPresentation(summary: summary(remote)).source == expected)
    }

    @Test func samplesHaveNoSourceLine() {
        #expect(ResultPresentation(summary: summary(nil, sample: true)).source == nil)
    }
}

/// An API that answers after `delay` (simulates a slow remote-assisted analysis).
actor SlowAPI: ScamShieldAPI {
    let delay: Duration
    private(set) var calls = 0
    init(delay: Duration) { self.delay = delay }
    func scanMessage(_ text: String) async throws -> AnalysisSummary {
        calls += 1
        try await Task.sleep(for: delay)
        return try MockScamShieldAPI.sample(for: .critical)
    }
    func analyzeURL(_ url: String) async throws -> AnalysisSummary { try MockScamShieldAPI.sample(for: .critical) }
    func healthCheck() async throws -> BackendHealth { BackendHealth(status: "ok", checks: ["llm": "opt_in"], appVersion: nil) }
}

@MainActor
@Suite("Phase 4 — cancellation and repeated scans")
struct CancellationTests {
    func deps(api: any ScamShieldAPI) -> ScannerDependencies {
        ScannerDependencies(permission: FakePermission(.granted), targets: FakeTargets(region: nil), capturer: CaptureSpy(),
                            recognizer: FakeOCR(text: "Your KYC has expired. Share OTP."), api: api, analysisGate: nil)
    }

    @Test func closingDuringSlowAnalysisDropsTheLateResultAndANewScanWorks() async throws {
        let c = ScannerCoordinator(minimumStageDuration: .zero, textReadyHold: .zero, sleep: { _ in })
        let slow = SlowAPI(delay: .milliseconds(400))
        #expect(c.start(.fullScreen, with: deps(api: slow)))
        for _ in 0..<100 where c.phase != .sendingForAnalysis { try await Task.sleep(for: .milliseconds(5)) }
        #expect(c.phase == .sendingForAnalysis)
        #expect(!c.start(.fullScreen, with: deps(api: slow))) // a second scan can't start while one runs
        c.dismiss()
        try await Task.sleep(for: .milliseconds(600))
        #expect(c.phase == .idle) // the late answer never appears

        let fast = SlowAPI(delay: .zero)
        #expect(c.start(.fullScreen, with: deps(api: fast)))
        await c.waitUntilFinished()
        #expect(c.phase.isResult)
        #expect(await slow.calls == 1)
        #expect(await fast.calls == 1)
    }
}
