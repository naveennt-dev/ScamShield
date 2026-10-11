#if SCAMSHIELD_DEVTOOLS
// Developer tool — compiled only into development builds (SCAMSHIELD_DEVTOOLS=1).
import AppKit
import ScamShieldCore
import ScamShieldDevSupport
import ScamShieldUI
import ScreenCaptureKit
import SwiftUI

/// Real on-screen screenshots of ScamShield's OWN windows (`ScamShield --ui-capture <dir>`).
///
/// Unlike the self-test's view snapshots (which can't show materials or Liquid Glass), these are
/// window-server composites taken with ScreenCaptureKit. The capture filter contains only this
/// process's windows, so nothing else on the user's screen is ever captured: a synthetic, busy
/// backdrop window sits behind the menu and the scanner card to show translucency and to test text
/// contrast in the worst case. Scanner states use sample data (never recorded in History).
@MainActor
final class UICapture {
    private let state: AppState
    private let menuBar: MenuBarController
    private let out: URL
    private var log: [[String: Any]] = []

    init(state: AppState, menuBar: MenuBarController, outputDirectory: URL) {
        self.state = state
        self.menuBar = menuBar
        self.out = outputDirectory
    }

    func run() {
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        Task { @MainActor in
            await self.execute()
            NSApp.terminate(nil)
        }
    }

    private func execute() async {
        let userAlwaysOnTop = state.settings.scannerAlwaysOnTop
        defer { state.settings.scannerAlwaysOnTop = userAlwaysOnTop }
        state.settings.scannerAlwaysOnTop = true
        state.scannerPanel.panel.ignoresMouseEvents = true

        guard let screen = NSScreen.main else { return write(error: "no screen") }
        let backdrop = Self.backdropWindow(frame: screen.frame)
        backdrop.orderFrontRegardless()
        defer { backdrop.orderOut(nil) }
        await pause(800)

        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            await pause(500)

            // SCAMSHIELD_CAPTURE_ONLY=windows: just the standard windows (quick layout checks).
            let windowsOnly = ProcessInfo.processInfo.environment["SCAMSHIELD_CAPTURE_ONLY"] == "windows"
            if !windowsOnly {
            // Menu-bar popover (the real one, anchored to the real status item). A status-item
            // popover follows the menu bar's appearance, so it is set explicitly for each variant.
            menuBar.popover.appearance = NSAppearance(named: appearance)
            for (suffix, row) in [("", nil as String?), ("-highlighted", "Scan Screen")] {
                menuBar.rebuildContent(highlighting: row)
                menuBar.showPopover()
                for _ in 0..<60 where !menuBar.popover.isShown { await pause(50) }
                await pause(700)
                if let pop = menuBar.popover.contentViewController?.view.window, let item = menuBar.statusItem.button?.window {
                    await capture(pop.frame.union(item.frame).insetBy(dx: -28, dy: -28), screen: screen, name: "menu-\(name)\(suffix)", required: pop)
                }
                menuBar.closePopover()
                await pause(400)
            }
            menuBar.rebuildContent(highlighting: nil)
            menuBar.popover.appearance = nil

            // Scanner card in each result state.
            for scenario in [PreviewScenario.critical, .suspicious, .safe, .serviceDown] {
                state.preview(scenario)
                for _ in 0..<100 where !state.coordinator.phase.isResult { await pause(50) }
                await pause(900) // result animation
                for _ in 0..<40 where !state.scannerPanel.panel.isVisible { await pause(50) }
                await capture(state.scannerPanel.panel.frame.insetBy(dx: -28, dy: -28), screen: screen, name: "scanner-\(scenario.rawValue)-\(name)",
                              required: state.scannerPanel.panel)
                state.closeScanner(reason: "ui-capture")
                await pause(300)
            }
            }

            // Standard windows (system controls follow the linked SDK's design). Developer runs
            // use a throw-away History, so no user scans appear here.
            for (title, open) in [("ScamShield Settings", { self.state.openSettings() }),
                                  ("ScamShield History", { self.state.openHistory() }),
                                  ("Scan Link", { self.state.openLinkScan() })] as [(String, () -> Void)] {
                open()
                var window: NSWindow?
                for _ in 0..<40 where window == nil { await pause(50); window = NSApp.windows.first { $0.title == title && $0.isVisible } }
                guard let window else { log.append(["name": title, "error": "window did not open"]); continue }
                // Shown on whichever Space is active (someone may be using the Mac meanwhile).
                let behaviour = window.collectionBehavior
                window.collectionBehavior.insert(.canJoinAllSpaces)
                defer { window.collectionBehavior = behaviour }
                window.orderFrontRegardless()
                await pause(1200)
                let slug = title.lowercased().replacingOccurrences(of: "scamshield ", with: "").replacingOccurrences(of: " ", with: "-")
                await capture(window.frame.insetBy(dx: -28, dy: -28), screen: screen, name: "window-\(slug)-\(name)", required: window)
                window.orderOut(nil)
                await pause(300)
            }
        }
        NSApp.appearance = nil
        write(error: nil)
    }

    /// Captures `rect` (AppKit screen coordinates) with only this app's windows composited.
    /// `required` must be in the window list (it can lag a just-shown window); retried, else an error.
    private func capture(_ rect: NSRect, screen: NSScreen, name: String, required: NSWindow) async {
        do {
            let pid = ProcessInfo.processInfo.processIdentifier
            var content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            for _ in 0..<20 where !content.windows.contains(where: { $0.windowID == CGWindowID(required.windowNumber) }) {
                await pause(100)
                content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            }
            guard content.windows.contains(where: { $0.windowID == CGWindowID(required.windowNumber) }) else { throw CaptureError.windowNotOnScreen }
            let mine = content.windows.filter { $0.owningApplication?.processID == pid }
            let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID ?? CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw CaptureError.noDisplay }
            let clipped = rect.intersection(screen.frame)
            let cfg = SCStreamConfiguration()
            // ScreenCaptureKit uses a top-left origin in display points.
            cfg.sourceRect = CGRect(x: clipped.minX - screen.frame.minX, y: screen.frame.maxY - clipped.maxY,
                                    width: clipped.width, height: clipped.height)
            cfg.width = Int(clipped.width * screen.backingScaleFactor)
            cfg.height = Int(clipped.height * screen.backingScaleFactor)
            cfg.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, including: mine), configuration: cfg)
            let rep = NSBitmapImageRep(cgImage: image)
            let file = out.appendingPathComponent("\(name).png")
            try rep.representation(using: .png, properties: [:])?.write(to: file)
            log.append(["name": name, "file": file.lastPathComponent, "windowsIncluded": mine.count, "points": "\(Int(clipped.width))x\(Int(clipped.height))"])
        } catch {
            log.append(["name": name, "error": "\(error)"])
        }
    }

    private enum CaptureError: Error { case noDisplay, windowNotOnScreen }

    private func write(error: String?) {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        var glass = false
        if #available(macOS 26, *) { glass = true }
        let report: [String: Any] = [
            "macOS": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            "osBuild": ProcessInfo.processInfo.operatingSystemVersionString,
            "liquidGlassAPIsAvailable": glass,
            "reduceTransparency": NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency,
            "increaseContrast": NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast,
            "captures": log,
            "error": error ?? NSNull(),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: out.appendingPathComponent("capture-report.json"))
        }
    }

    private func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }

    /// Busy, high-contrast synthetic backdrop (colour bands + text) — no user content.
    private static func backdropWindow(frame: NSRect) -> NSWindow {
        let w = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        w.title = "ScamShield UI capture backdrop"
        w.isReleasedWhenClosed = false
        w.level = .normal
        w.ignoresMouseEvents = true
        w.collectionBehavior = [.canJoinAllSpaces] // on the active Space even if the user switches
        w.setFrame(frame, display: false) // borderless: also covers the menu-bar strip in the capture
        w.contentView = NSHostingView(rootView: CaptureBackdrop())
        return w
    }
}

private struct CaptureBackdrop: View {
    /// SCAMSHIELD_CAPTURE_BACKDROP=calm: a soft wallpaper-like gradient for documentation screenshots
    /// (default: the busy, high-contrast backdrop used for contrast testing).
    private let calm = ProcessInfo.processInfo.environment["SCAMSHIELD_CAPTURE_BACKDROP"] == "calm"
    private let colors: [Color] = [.red, .orange, .yellow, .green, .teal, .blue, .indigo, .purple, .pink, .white, .black]

    var body: some View {
        if calm {
            LinearGradient(colors: [Color(red: 0.36, green: 0.55, blue: 0.86), Color(red: 0.62, green: 0.48, blue: 0.82), Color(red: 0.93, green: 0.62, blue: 0.62)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .ignoresSafeArea()
        } else {
            busy
        }
    }

    private var busy: some View {
        GeometryReader { geo in
            ZStack {
                HStack(spacing: 0) {
                    ForEach(Array(colors.enumerated()), id: \.offset) { _, c in c }
                }
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(0..<Int(geo.size.height / 26), id: \.self) { i in
                        Text(String(repeating: "Backdrop text for contrast testing — ScamShield UI capture. ", count: 6))
                            .font(.system(size: 17, weight: i % 2 == 0 ? .bold : .regular))
                            .foregroundStyle(i % 3 == 0 ? Color.black : (i % 3 == 1 ? Color.white : Color.blue))
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .ignoresSafeArea()
    }
}
#endif
