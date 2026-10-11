import AppKit
import Observation
import OSLog
import ScamShieldCore

/// App-wide state and actions shared by the menu bar, scanner panel, settings window and hotkey.
@MainActor
@Observable
final class AppState: NSObject {
    let settings: SettingsStore
    let coordinator: ScannerCoordinator
    /// Phase 5: local scan history + the user's own reports (this Mac only).
    let history: HistoryStore
    let reports: ReportStore
    /// Opt-in shared learning: queued feedback + masked text (off by default).
    let contributions: ContributionOutbox
    @ObservationIgnored private(set) lazy var historyWindow = HistoryWindowController(
        history: history, reports: reports, contributions: contributions,
        onFeedbackSaved: { [weak self] in self?.shareQueuedFeedback() })
    /// History entry of the most recent recorded scan (for "View in History" on the result card).
    @ObservationIgnored private(set) var lastHistoryEntryID: UUID?
    /// True while a developer sample preview runs (development builds only) — never recorded.
    @ObservationIgnored var previewRunning = false

    @ObservationIgnored private(set) lazy var scannerPanel = ScannerPanelController(state: self)
    @ObservationIgnored private(set) lazy var settingsWindow = SettingsWindowController(store: settings)
    @ObservationIgnored let hotkey = GlobalHotkeyManager()
    @ObservationIgnored let regionSelector = RegionSelectionService()
    @ObservationIgnored let permission = ScreenCapturePermission()
    /// False until Vision's one-time model preparation has finished (see OCRService.prewarm).
    private(set) var ocrReady = false
    @ObservationIgnored private(set) var ocrWarmupDuration: Duration?
    @ObservationIgnored private var lastHealthCheck: Date?
    @ObservationIgnored private var localOnlyGuard: LocalOnlyGuard?
    /// Overridable by the self-test (e.g. to capture its own fixture window).
    #if SCAMSHIELD_DEVTOOLS
    @ObservationIgnored var dependencyOverride: ((ScannerDependencies) -> ScannerDependencies)?
    #endif

    private static let log = Logger(subsystem: "dev.scamshield.mac", category: "scanner")

    /// The bundled on-device engine (nil-layout engines just reuse a running developer service).
    @ObservationIgnored var engine: EngineManager?

    init(settings: SettingsStore, coordinator: ScannerCoordinator, history: HistoryStore, reports: ReportStore,
         contributions: ContributionOutbox? = nil) {
        self.contributions = contributions ?? ContributionOutbox(directory: history.fileURL.deletingLastPathComponent(),
                                                                 appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0")
        self.settings = settings
        self.coordinator = coordinator
        self.history = history
        self.reports = reports
        super.init()
        // Record finished real scans (sample results are skipped by the store). The text
        // is used in memory only; storage failures are surfaced in the History window, never here.
        coordinator.onAnalyzed = { [weak self] scanID, summary, text in
            guard let self else { return }
            if let e = self.history.record(scanID: scanID, summary: summary, text: text, mode: self.settings.configuration.effectiveAnalysisMode,
                                           captureMode: self.coordinator.captureMode) {
                self.lastHistoryEntryID = e.id
            }
        }
        hotkey.onTrigger = { [weak self] in self?.scan(.fullScreen) }
        settings.onShortcutChanged = { [weak self] in self?.registerHotkey($0) }
        settings.onConfigurationChanged = { [weak self] _ in
            self?.lastHealthCheck = nil
            self?.localOnlyGuard = nil
        }
        coordinator.onPhaseChange = { [weak self] phase in self?.phaseChanged(phase) }
        registerHotkey(settings.shortcut)
        Task { [weak self] in
            let d = await OCRService.prewarm()
            self?.ocrWarmupDuration = d
            self?.ocrReady = true
            Self.log.info("ocr prewarm finished in \(d.components.seconds, privacy: .public)s")
        }
    }

    /// Waits until OCR is warm (self-test / diagnostics).
    func waitForOCRReady(timeout: Duration) async -> Bool {
        let clock = ContinuousClock(), deadline = clock.now + timeout
        while !ocrReady, clock.now < deadline { try? await Task.sleep(for: .milliseconds(200)) }
        return ocrReady
    }

    /// The backend client for the current configuration — always the local service.
    /// Sends queued opt-in feedback to the connected ScamShield service (retried on next feedback/launch).
    func shareQueuedFeedback() {
        guard contributions.isEnabled, !contributions.pending.isEmpty else { return }
        let sender = ContributionSender(baseURL: settings.configuration.apiBaseURL)
        Task { await contributions.flush(using: { await sender.send($0) }) }
    }

    func makeAPI() -> any ScamShieldAPI {
        LocalScamShieldAPI(baseURL: settings.configuration.apiBaseURL, analysisMode: settings.configuration.effectiveAnalysisMode)
    }

    /// Real scan dependencies: TCC permission, AppKit target selection, ScreenCaptureKit,
    /// Apple Vision, local API behind the local-only gate.
    func makeDependencies() -> ScannerDependencies {
        let api = makeAPI()
        let gate = localOnlyGuard ?? LocalOnlyGuard(api: api, mode: settings.configuration.effectiveAnalysisMode)
        localOnlyGuard = gate
        let deps = ScannerDependencies(
            permission: permission,
            targets: regionSelector,
            capturer: ScreenCaptureService(),
            recognizer: OCRService(),
            api: api,
            analysisGate: gate
        )
        #if SCAMSHIELD_DEVTOOLS
        return dependencyOverride?(deps) ?? deps
        #else
        return deps
        #endif
    }

    // MARK: Actions

    @ObservationIgnored private(set) var lastMode: CaptureMode = .fullScreen

    func scan(_ mode: CaptureMode) {
        lastMode = mode
        guard !coordinator.phase.isBusy else {
            if !regionSelector.isPresenting { scannerPanel.show() }
            return
        }
        Self.log.info("scan requested mode=\(mode.rawValue, privacy: .public)")
        previewRunning = false
        coordinator.start(mode, with: makeDependencies())
    }

    /// Why the scanner was last closed (diagnostics; shown in self-test failures).
    @ObservationIgnored private(set) var lastCloseReason = "none"

    func closeScanner(reason: String = "programmatic") {
        lastCloseReason = reason
        if regionSelector.isPresenting { regionSelector.cancel() }
        coordinator.dismiss()
        scannerPanel.hide()
    }

    func openScreenRecordingSettings() {
        NSWorkspace.shared.open(ScreenCapturePermission.settingsURL)
    }

    func openSettings() {
        settingsWindow.show()
    }

    @ObservationIgnored private(set) lazy var linkScanWindow = LinkScanWindowController(state: self)

    func openLinkScan() {
        linkScanWindow.show()
    }

    func openHistory(selecting id: UUID? = nil) {
        historyWindow.show(selecting: id)
    }

    @objc func openHistoryAction() {
        openHistory()
    }

    @objc func openSettingsAction() {
        openSettings()
    }

    func refreshConnectionIfStale() {
        if let last = lastHealthCheck, Date().timeIntervalSince(last) < 30 { return }
        lastHealthCheck = Date()
        Task { await settings.testConnection() }
    }

    func shutdown() {
        hotkey.unregister()
        engine?.stop()
    }

    /// Starts (or re-uses) the analysis engine, then refreshes the connection status.
    func startEngine() {
        guard let engine else { return }
        settings.engineStatus = "Starting the analysis engine…"
        settings.engineFailed = false
        Task { @MainActor in
            await engine.start()
            switch engine.state {
            case .running(let managed):
                settings.engineStatus = managed ? "Analysis engine running on this device." : "Using the ScamShield service already running on this device."
                settings.engineFailed = false
            case .failed(let why):
                settings.engineStatus = why
                settings.engineFailed = true
            default:
                break
            }
            await settings.testConnection()
        }
    }

    /// Applies a changed AI key: the engine reads it only at start.
    func restartEngine() {
        engine?.stop()
        startEngine()
    }

    // MARK: Private

    /// The scanner card is hidden while the user selects a region, so it never covers the message.
    private func phaseChanged(_ phase: ScannerPhase) {
        switch phase {
        case .selectingRegion:
            scannerPanel.hide()
        case .cancelled:
            scannerPanel.hide()
            coordinator.dismiss()
        case .idle:
            scannerPanel.hide()
        default:
            // A real scan the user started but that couldn't be assessed is recorded as such
            // (no score) — never as safe. Previews and permission prompts aren't scans.
            if case .failed(let f) = phase, !previewRunning, f != .permissionRequired {
                if let e = history.recordFailure(scanID: coordinator.scanID, reason: "\(f.title) \(f.message)",
                                                 mode: settings.configuration.effectiveAnalysisMode, captureMode: coordinator.captureMode) {
                    lastHistoryEntryID = e.id
                }
            }
            // Results take focus (Return/Esc work); in-progress stages never do.
            scannerPanel.show(takeFocus: phase.isResult)
        }
        // Log the stage only — never OCR text.
        Self.log.debug("phase \(String(describing: phase.stage), privacy: .public)")
    }

    private func registerHotkey(_ shortcut: HotkeyShortcut?) {
        switch hotkey.register(shortcut) {
        case .success: settings.shortcutStatus = nil
        case .failure(let error): settings.shortcutStatus = error.localizedDescription
        }
    }
}
