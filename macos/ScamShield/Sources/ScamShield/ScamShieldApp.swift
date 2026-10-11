import AppKit
import OSLog

/// Entry point. ScamShield is a menu-bar ("accessory") app: no Dock icon and no window at launch.
/// `LSUIElement` in Info.plist enforces the same when launched as an .app bundle.
@main
enum ScamShieldApp {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var environment: AppEnvironment?
    private var menuBar: MenuBarController?
    private let consent = ConsentWindowController()

    /// Posted by a second launch so the running instance opens its menu instead of a duplicate app.
    static let reopenNotification = Notification.Name("dev.scamshield.mac.reopen")
    private static let log = Logger(subsystem: "dev.scamshield.mac", category: "app")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = ProcessInfo.processInfo.arguments
        // Single instance: a second launch (Finder, Spotlight, `open -n`) hands over and quits, so
        // there is never a second menu-bar icon, hotkey registration or scanner window. The
        // self-test is exempt: it is an isolated, scripted instance that quits when done.
        if !args.contains("--self-test"), !args.contains("--scan-eval"), let other = Self.otherRunningInstance() {
            Self.log.notice("another ScamShield instance is running (pid \(other.processIdentifier, privacy: .public)); handing over")
            DistributedNotificationCenter.default().postNotificationName(Self.reopenNotification, object: nil, userInfo: nil, deliverImmediately: true)
            NSApp.terminate(nil)
            return
        }
        let env = AppEnvironment.live()
        environment = env
        menuBar = MenuBarController(state: env.state)
        env.installMainMenu()
        env.applyLaunchArguments(menuBar: menuBar!)
        DistributedNotificationCenter.default().addObserver(forName: Self.reopenNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.menuBar?.showPopover() }
        }
        #if SCAMSHIELD_DEVTOOLS
        let developerRun = AppState.isDeveloperSession
        #else
        let developerRun = false
        #endif
        if !developerRun {
            consent.showIfNeeded(store: env.state.settings)
            env.state.shareQueuedFeedback() // retry opt-in feedback queued while the service was down
        }
        if let ms = Self.millisecondsSinceProcessStart() {
            Self.log.notice("launch ready in \(ms, privacy: .public) ms")
        }
    }

    static func otherRunningInstance() -> NSRunningApplication? {
        guard let id = Bundle.main.bundleIdentifier else { return nil }
        let me = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication.runningApplications(withBundleIdentifier: id).first {
            $0.processIdentifier != me && !$0.isTerminated
        }
    }

    /// Time since this process was created (startup measurement; kernel process start time).
    static func millisecondsSinceProcessStart() -> Int? {
        var kp = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, ProcessInfo.processInfo.processIdentifier]
        guard sysctl(&mib, 4, &kp, &size, nil, 0) == 0 else { return nil }
        let start = kp.kp_proc.p_un.__p_starttime
        let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
        return Int((Date().timeIntervalSince1970 - started) * 1000)
    }

    func applicationWillTerminate(_ notification: Notification) {
        environment?.state.shutdown()
        #if SCAMSHIELD_DEVTOOLS
        if let dir = SelfTest.outputDirectory {
            try? "terminated cleanly via NSApp.terminate\n".write(to: dir.appendingPathComponent("terminated.txt"), atomically: true, encoding: .utf8)
        }
        #endif
    }
}
