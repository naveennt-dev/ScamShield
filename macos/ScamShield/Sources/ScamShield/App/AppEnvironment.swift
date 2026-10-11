import AppKit
import OSLog
import ScamShieldCore
#if SCAMSHIELD_DEVTOOLS
import ScamShieldDevSupport
#endif

/// Composition root: builds the object graph from configuration. Swap implementations here
/// (e.g. the Phase 2 screen-capture provider) without touching UI code.
@MainActor
struct AppEnvironment {
    let state: AppState

    static let log = Logger(subsystem: "dev.scamshield.mac", category: "app")

    static func live() -> AppEnvironment {
        let settings = SettingsStore()
        for problem in settings.loadProblems {
            log.warning("configuration problem: \(problem, privacy: .public)")
        }
        let config = settings.configuration
        log.info("launch env=\(config.environment.rawValue, privacy: .public) api=\(config.apiBaseURL.absoluteString, privacy: .public)")
        var historyDir = HistoryStore.defaultDirectory
        var historyDefaults = UserDefaults.standard
        #if SCAMSHIELD_DEVTOOLS
        // Developer runs (self-test / scan-eval) use a throw-away history so they never touch the user's.
        if AppState.isDeveloperSession {
            historyDir = FileManager.default.temporaryDirectory.appendingPathComponent("scamshield-selftest-history-\(UUID().uuidString)")
            historyDefaults = UserDefaults(suiteName: "dev.scamshield.selftest.\(UUID().uuidString)")!
        }
        #endif
        let state = AppState(settings: settings, coordinator: ScannerCoordinator(),
                                              history: HistoryStore(directory: historyDir, defaults: historyDefaults),
                                              reports: ReportStore(directory: historyDir),
                                              contributions: ContributionOutbox(
                                                directory: historyDir, defaults: historyDefaults,
                                                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"))
        // On-device engine: bundled in installed apps (Contents/Resources/engine). Developer builds
        // without it keep using scripts/scamshield.sh.
        let layout = EngineLayout.bundled()
        SettingsStore.managedEngine = layout != nil
        let support = HistoryStore.defaultDirectory
        let base = config.apiBaseURL
        state.engine = EngineManager(
            baseURL: base,
            layout: layout,
            logURL: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ScamShield/engine.log"),
            environment: { EngineEnvironment.make(port: base.port ?? 3000, authSecret: EngineEnvironment.authSecret(in: support), aiKey: AIKeyStore.read()) })
        settings.retryEngine = { [weak state] in state?.restartEngine() }
        settings.onAIKeyChanged = { [weak state] in state?.restartEngine() }
        settings.onScannerLevelChanged = { [weak state] on in state?.scannerPanel.setAlwaysOnTop(on) }
        return AppEnvironment(state: state)
    }

    /// Accessory apps still get key equivalents from the main menu while one of their windows is key
    /// (⌘, settings, ⌘W close, ⌘Q quit).
    func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu(title: "ScamShield")
        appMenu.addItem(withTitle: "Settings…", action: #selector(AppState.openSettingsAction), keyEquivalent: ",").target = state
        appMenu.addItem(withTitle: "History…", action: #selector(AppState.openHistoryAction), keyEquivalent: "y").target = state
        appMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit ScamShield", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    /// Launch arguments: --open-settings, --scan-screen, --select-region.
    /// Development builds also accept --self-test <dir>, --scan-eval <messages> <dir>, --preview <scenario>.
    func applyLaunchArguments(menuBar: MenuBarController) {
        let args = ProcessInfo.processInfo.arguments
        #if SCAMSHIELD_DEVTOOLS
        if let i = args.firstIndex(of: "--self-test"), i + 1 < args.count {
            SelfTest(state: state, menuBar: menuBar, outputDirectory: URL(fileURLWithPath: args[i + 1])).run()
            return
        }
        if let i = args.firstIndex(of: "--scan-eval"), i + 2 < args.count {
            ScanEval(state: state, messages: URL(fileURLWithPath: args[i + 1]), outputDirectory: URL(fileURLWithPath: args[i + 2])).run()
            return
        }
        if let i = args.firstIndex(of: "--preview"), i + 1 < args.count, let s = PreviewScenario(rawValue: args[i + 1]) {
            state.preview(s)
        }
        #endif
        if args.contains("--open-settings") { state.openSettings() }
        if args.contains("--scan-screen") { state.scan(.fullScreen) }
        if args.contains("--select-region") { state.scan(.region) }
    }
}
