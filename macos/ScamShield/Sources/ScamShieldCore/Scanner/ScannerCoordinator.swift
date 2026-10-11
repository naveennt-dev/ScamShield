import Foundation
import OSLog
import Observation

/// Everything a scan needs. Real implementations: ScreenCapturePermission, RegionSelectionService
/// (app), ScreenCaptureService, OCRService, LocalScamShieldAPI (+ LocalOnlyGuard).
public struct ScannerDependencies {
    public var permission: any ScreenCapturePermissionProviding
    public var targets: any CaptureTargetSelecting
    public var capturer: any ScreenCapturing
    public var recognizer: any TextRecognizing
    public var api: any ScamShieldAPI
    /// Phase 2 privacy gate: verifies the local service will not forward text to cloud AI.
    public var analysisGate: (any AnalysisGate)?

    public init(
        permission: any ScreenCapturePermissionProviding,
        targets: any CaptureTargetSelecting,
        capturer: any ScreenCapturing,
        recognizer: any TextRecognizing,
        api: any ScamShieldAPI,
        analysisGate: (any AnalysisGate)?
    ) {
        self.permission = permission
        self.targets = targets
        self.capturer = capturer
        self.recognizer = recognizer
        self.api = api
        self.analysisGate = analysisGate
    }
}

/// Drives one explicit, user-initiated scan through `ScannerMachine`:
/// permission → (region selection) → capture → OCR → text validation → local analysis → result.
///
/// Privacy: the captured image lives only inside `run`'s scope and is released right after OCR.
/// Nothing is written to disk. No scan ever starts without a user action.
@MainActor
@Observable
public final class ScannerCoordinator {
    public private(set) var phase: ScannerPhase = .idle

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let minimumStageDuration: Duration
    @ObservationIgnored private let textReadyHold: Duration
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    /// Called when a phase is entered (the app hides/shows the scanner card around region selection).
    @ObservationIgnored public var onPhaseChange: ((ScannerPhase) -> Void)?
    /// Called once per finished real analysis, with the scan's id and the validated text. The text is
    /// handed over in memory only (the app's history keeps a salted digest, never the text).
    @ObservationIgnored public var onAnalyzed: ((_ scanID: UUID, _ summary: AnalysisSummary, _ text: String) -> Void)?
    /// Identifies the current scan (new for every `start`).
    @ObservationIgnored public private(set) var scanID = UUID()
    private static let log = Logger(subsystem: "dev.scamshield.mac", category: "scan")
    /// What the current scan captures (full screen or a selected region).
    @ObservationIgnored public private(set) var captureMode: CaptureMode = .fullScreen

    public init(
        minimumStageDuration: Duration = .milliseconds(450),
        textReadyHold: Duration = .milliseconds(700),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.minimumStageDuration = minimumStageDuration
        self.textReadyHold = textReadyHold
        self.sleep = sleep
    }

    @discardableResult
    public func send(_ event: ScannerEvent) -> Bool {
        guard let next = ScannerMachine.reduce(phase, event) else { return false }
        phase = next
        onPhaseChange?(next)
        return true
    }

    @discardableResult
    public func start(_ mode: CaptureMode, with deps: ScannerDependencies) -> Bool {
        guard !phase.isBusy, send(.start(mode)) else { return false }
        scanID = UUID()
        captureMode = mode
        let id = scanID
        Self.log.notice("scan \(id.uuidString, privacy: .public) start mode=\(mode.rawValue, privacy: .public)")
        task = Task { [weak self] in await ScanContext.$scanID.withValue(id) { await self?.run(mode, deps) } }
        return true
    }

    public func dismiss() {
        task?.cancel()
        task = nil
        send(.dismiss)
    }

    public func waitUntilFinished() async {
        await task?.value
    }

    private func run(_ mode: CaptureMode, _ deps: ScannerDependencies) async {
        do {
            // 1. Permission (checked every scan: it can be revoked at any time).
            switch deps.permission.status() {
            case .granted: break
            case .notRequested:
                if deps.permission.request() != .granted { throw ScannerFailure.permissionRequired }
            case .promptShown: throw ScannerFailure.permissionRequired
            case .denied: throw ScannerFailure.permissionDenied
            }
            send(.permissionGranted)

            // 2. Target
            let target: CaptureTarget
            if mode == .region {
                guard let selected = await deps.targets.selectRegion() else {
                    send(.cancel)
                    return
                }
                try Task.checkCancellation()
                target = selected
                send(.regionSelected)
            } else {
                guard let t = deps.targets.currentDisplayTarget() else { throw ScannerFailure.captureFailed }
                target = t
            }

            // 3. Capture + OCR. The image never leaves this block.
            let ocr: OCRResult
            do {
                async let minimum: Void = sleep(minimumStageDuration)
                let image: CapturedImage
                do {
                    image = try await deps.capturer.capture(target)
                    Self.log.notice("scan \(self.scanID.uuidString, privacy: .public) captured \(image.pixelWidth, privacy: .public)x\(image.pixelHeight, privacy: .public)px kind=\(target.kind.rawValue, privacy: .public)")
                } catch CaptureError.permissionDenied {
                    throw ScannerFailure.permissionDenied
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    throw ScannerFailure.captureFailed
                }
                try await minimum
                try Task.checkCancellation()
                send(.captured)

                async let minimumOCR: Void = sleep(minimumStageDuration)
                do {
                    ocr = try await deps.recognizer.recognizeText(in: image)
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    throw ScannerFailure.ocrFailed
                }
                try await minimumOCR
            } // `image` released here
            try Task.checkCancellation()

            // 4. Validate the untrusted text.
            Self.log.notice("scan \(self.scanID.uuidString, privacy: .public) ocr chars=\(ocr.text.count, privacy: .public) empty=\(ocr.text.isEmpty, privacy: .public)")
            guard let prepared = TextValidation.prepare(ocr.text) else { throw ScannerFailure.noTextDetected }
            send(.textRecognized(ExtractedTextSummary(
                lineCount: prepared.lineCount,
                characterCount: prepared.text.count,
                urlCount: prepared.urlCount,
                confidence: ocr.confidence,
                wasTruncated: prepared.wasTruncated,
                preview: String(prepared.text.prefix(600))
            )))
            try await sleep(textReadyHold)
            try Task.checkCancellation()

            // 5. Local analysis (through the ScamShieldAPI abstraction only).
            send(.submitted)
            async let minimumAnalysis: Void = sleep(minimumStageDuration)
            if let gate = deps.analysisGate { try await gate.verify() }
            let summary: AnalysisSummary
            do {
                summary = try await deps.api.scanMessage(prepared.text)
            } catch let e as ScamShieldAPIError {
                throw Self.map(e)
            }
            try await minimumAnalysis
            try Task.checkCancellation()
            Self.log.notice("scan \(self.scanID.uuidString, privacy: .public) result level=\(summary.riskLevel.rawValue, privacy: .public) score=\(summary.riskScore, privacy: .public) remote=\(summary.remote?.status ?? "none", privacy: .public)")
            // A "nothing found" from an incomplete check is not a safe result.
            if summary.riskLevel == .safe, !summary.assessmentGaps.isEmpty { throw ScannerFailure.unableToAssess(summary.assessmentGaps) }
            onAnalyzed?(scanID, summary, prepared.text)
            send(.analyzed(summary))
        } catch is CancellationError {
            // Dismissed by the user; nothing else to do.
        } catch {
            guard !Task.isCancelled else { return }
            let failure = (error as? ScannerFailure) ?? .analysisFailed("Something went wrong. Try again.")
            Self.log.notice("scan \(self.scanID.uuidString, privacy: .public) failed: \(failure.title, privacy: .public)")
            send(.failed(failure))
        }
    }

    static func map(_ error: ScamShieldAPIError) -> ScannerFailure {
        switch error {
        case .backendUnreachable: return .analysisServiceUnavailable
        // The service is running but didn't answer in time — saying "isn't running" would mislead.
        case .timedOut: return .analysisFailed("The local ScamShield service took too long to respond. Try again.")
        case .rateLimited: return .analysisFailed("Too many scans in a short time. Wait a minute and try again.")
        case .emptyInput: return .noTextDetected
        case .server(_, let message): return .analysisFailed(message)
        case .invalidResponse: return .analysisFailed("The ScamShield service sent an unexpected response.")
        }
    }
}
