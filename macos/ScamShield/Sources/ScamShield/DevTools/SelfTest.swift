#if SCAMSHIELD_DEVTOOLS
// Developer tool — compiled only into development builds (SCAMSHIELD_DEVTOOLS=1).
import AppKit
import Carbon.HIToolbox
import ScamShieldCore
import ScamShieldDevSupport
import ScamShieldUI
import SwiftUI

/// In-process smoke test of the REAL running app (`ScamShield --self-test <dir>`).
///
/// It drives the real code paths (status item, popover, scanner panel, region-selection overlay,
/// Vision OCR, local API, hotkey handler, settings, quit), snapshots only its OWN windows and
/// writes `report.json`. Real ScreenCaptureKit capture is exercised only if Screen Recording is
/// already granted; otherwise those checks are reported as SKIPPED (never faked).
@MainActor
final class SelfTest {
    private let state: AppState
    private let menuBar: MenuBarController
    private let out: URL
    private var checks: [(name: String, status: String, detail: String)] = []
    nonisolated(unsafe) static var outputDirectory: URL?

    nonisolated static let fixtureText = """
    Dear SBI customer, your KYC has expired.

    Update immediately:
    https://sbi-kyc-update.xyz/verify?id=42#login

    Your account may be blocked today.
    """
    nonisolated static let fixtureURL = "https://sbi-kyc-update.xyz/verify?id=42#login"

    init(state: AppState, menuBar: MenuBarController, outputDirectory: URL) {
        self.state = state
        self.menuBar = menuBar
        self.out = outputDirectory
    }

    /// Real keyboard/mouse input that reached ScamShield's windows during the run. The self-test
    /// itself never dispatches events through the queue (it calls views directly), so anything
    /// recorded here came from a person using the Mac — reported so failures can be attributed.
    private var userInput: [String] = []
    private var inputMonitor: Any?

    func run() {
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { [weak self] e in
            MainActor.assumeIsolated {
                self?.userInput.append("type=\(e.type.rawValue) window=\(e.window?.title ?? "-") at=\(NSEvent.mouseLocation)")
            }
            return e
        }
        // The self-test closes the card programmatically; a stray click from someone using the Mac
        // must not dismiss it mid-check (that caused the earlier 32/35 runs). Clicks pass through.
        state.scannerPanel.panel.ignoresMouseEvents = true
        Task { @MainActor in
            await self.execute()
            self.finish()
        }
    }

    private func check(_ name: String, _ passed: Bool, _ detail: String = "") {
        let input = userInput.isEmpty ? "" : "; real user input so far: \(userInput.count)"
        let d = passed ? detail : "\(detail) (last close reason: \(state.lastCloseReason)\(input))"
        checks.append((name, passed ? "pass" : "fail", d))
    }

    private func skip(_ name: String, _ detail: String) {
        checks.append((name, "skipped", detail))
    }

    private func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }

    private func kind(_ p: ScannerPhase) -> String {
        switch p {
        case .idle: return "idle"
        case .requestingPermission: return "requestingPermission"
        case .selectingRegion: return "selectingRegion"
        case .capturing: return "capturing"
        case .processingOCR: return "processingOCR"
        case .textReady: return "textReady"
        case .sendingForAnalysis: return "sendingForAnalysis"
        case .safe: return "safe"
        case .suspicious(let r): return r.tone == .danger ? "critical" : "suspicious"
        case .cancelled: return "cancelled"
        case .failed(let f): return "failed(\(f))"
        }
    }

    /// Longest gap between two main-actor polls during the last `observe` (UI responsiveness).
    private var lastObserveMaxGapMs = 0

    /// Records distinct phases until a terminal phase (or `stopAt`) is reached.
    private func observe(until stop: (ScannerPhase) -> Bool = { $0.isResult }, timeoutMs: Int = 30_000, snapshotPrefix: String? = nil) async -> [String] {
        var seen: [String] = []
        var waited = 0
        var last = ContinuousClock.now
        lastObserveMaxGapMs = 0
        while waited < timeoutMs {
            let now = ContinuousClock.now
            lastObserveMaxGapMs = max(lastObserveMaxGapMs, Int((now - last).components.attoseconds / 1_000_000_000_000_000 + (now - last).components.seconds * 1000))
            last = now
            let p = state.coordinator.phase
            let k = kind(p)
            if seen.last != k {
                seen.append(k)
                if case .textReady(let summary) = p { textPreviewLog.append(summary.preview) }
                if let snapshotPrefix, p.stage != nil { snapshot(state.scannerPanel.panel, "\(snapshotPrefix)-\(k)") }
            }
            if stop(p) || (p == .idle && seen.count > 1) { break }
            await pause(20)
            waited += 20
        }
        return seen
    }

    private func execute() async {
        let filesBefore = Self.imageFilesInTempLocations()

        // 1. Menu bar
        let button = menuBar.statusItem.button
        check("status item installed", button?.image != nil, "template=\(button?.image?.isTemplate ?? false)")
        await pause(300)
        check("status item is in the menu bar", button?.window != nil)
        let showsBefore = menuBar.popoverShowCount
        menuBar.showPopover()
        var shown = false
        for _ in 0..<60 where !shown { await pause(50); shown = menuBar.popover.isShown && menuBar.popoverShowCount > showsBefore }
        check("menu popover opens", shown,
              "didShow=\(menuBar.popoverShowCount > showsBefore) isShown=\(menuBar.popover.isShown) closedBy=\(menuBar.lastPopoverCloseReason) appActive=\(NSApp.isActive)")
        if shown, let v = menuBar.popover.contentViewController?.view { snapshot(v, "menu") }
        menuBar.closePopover()
        var closed = false
        for _ in 0..<40 where !closed { await pause(50); closed = !menuBar.popover.isShown }
        check("menu popover closes", closed)

        // 2. Preview walkthroughs (sample data) through every scanner state
        let previews: [(PreviewScenario, String)] = [
            (.safe, "safe"), (.suspicious, "suspicious"), (.critical, "critical"),
            (.serviceDown, "failed(analysisServiceUnavailable)"), (.permissionRequired, "failed(permissionRequired)"),
            (.noText, "failed(noTextDetected)"),
        ]
        for (scenario, expected) in previews {
            state.preview(scenario)
            let seen = await observe(snapshotPrefix: scenario == .safe ? "stage" : nil)
            check("preview \(scenario.rawValue) → \(expected)", seen.last == expected, seen.joined(separator: " → "))
            await pause(450)
            snapshot(state.scannerPanel.panel, "state-\(scenario.rawValue)")
            state.closeScanner(reason: "self-test")
            await pause(150)
        }

        await windowChecks()
        await soakCheck()

        // Vision's one-time model preparation runs in the background from launch.
        let warm = await state.waitForOCRReady(timeout: .seconds(150))
        check("OCR prewarmed in background at launch", warm, state.ocrWarmupDuration.map { "took \($0.components.seconds)s (one-time per app binary)" } ?? "not finished")

        // 3. Region selection overlay (real overlay windows, simulated drag) + coordinate mapping
        let recorder = RecordingCapture()
        state.dependencyOverride = { deps in
            var d = deps
            d.permission = PreviewPermission(.granted)
            d.capturer = recorder
            d.api = MockScamShieldAPI(scenario: .critical)
            d.analysisGate = nil
            return d
        }
        state.scan(.region)
        _ = await observe(until: { $0 == .selectingRegion }, timeoutMs: 3000)
        await pause(300)
        let overlays = state.regionSelector.windows
        let framesMatch = overlays.count == NSScreen.screens.count && overlays.allSatisfy { w in w.screen.map { $0.frame == w.frame } ?? false }
        check("overlay covers every display", framesMatch, "\(overlays.count) overlay(s) for \(NSScreen.screens.count) display(s)")
        check("scanner card hidden during selection", !state.scannerPanel.isVisible)
        if let w = overlays.first(where: { $0.screen == RegionSelectionService.screenUnderPointer() }) ?? overlays.first, let screen = w.screen {
            snapshot(w.selectionView, "overlay-empty", scale: 0.5)
            w.selectionView.simulateDrag(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 15, y: 14))
            check("tiny selection is rejected", w.selectionView.selection == nil && !w.selectionView.areButtonsVisible)
            w.selectionView.simulateDrag(from: CGPoint(x: 500.3, y: 320.7), to: CGPoint(x: 100.2, y: 120.4))
            check("selection shows Scan/Cancel", w.selectionView.areButtonsVisible)
            snapshot(w.selectionView, "overlay-selected", scale: 0.5)
            w.selectionView.confirmSelection()
            let seen = await observe()
            let t = await recorder.lastTarget
            let scale = screen.backingScaleFactor
            let expectedRect = CaptureGeometry.normalized(CGRect(x: 100.2, y: 120.4, width: 400.1, height: 200.3), displaySize: screen.frame.size, scale: scale)!
            check("selection maps to display-local points", t?.sourceRect == expectedRect && t?.displayID == screen.displayID, "\(t.map { "\($0.sourceRect)" } ?? "nil") on display \(t?.displayID ?? 0)")
            check("pixel size uses the display's scale (\(scale)×)", t?.pixelSize == CaptureGeometry.pixelSize(of: expectedRect, scale: scale), "\(t?.pixelSize ?? .zero)")
            check("region flow: selecting → capturing → OCR → text → analysis → result",
                  seen.starts(with: ["selectingRegion", "capturing", "processingOCR", "textReady", "sendingForAnalysis"]) && seen.last == "critical",
                  seen.joined(separator: " → "))
        } else {
            check("overlay window available", false)
        }
        state.closeScanner(reason: "self-test")
        await pause(200)

        // 4. Esc cancels selection without capturing
        await recorder.reset()
        state.scan(.region)
        _ = await observe(until: { $0 == .selectingRegion }, timeoutMs: 3000)
        await pause(200)
        if let w = state.regionSelector.windows.first,
           let esc = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber,
                                      context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
            w.selectionView.keyDown(with: esc)
        }
        await pause(300)
        let captures = await recorder.count
        check("Esc cancels selection; nothing captured", state.coordinator.phase == .idle && state.regionSelector.windows.isEmpty && captures == 0 && !state.scannerPanel.isVisible, "captures=\(captures)")

        // 5. Real Vision OCR on a rendered message (no screen access) → local API
        let expectBackend = ProcessInfo.processInfo.environment["SCAMSHIELD_SELFTEST_EXPECT_BACKEND"] == "1"
        state.dependencyOverride = { deps in
            var d = deps
            d.permission = PreviewPermission(.granted)
            d.capturer = FixtureCapture(text: SelfTest.fixtureText)
            d.targets = PreviewTargets()
            if !expectBackend {
                d.api = MockScamShieldAPI(scenario: .critical)
                d.analysisGate = nil
            }
            return d
        }
        state.scan(.fullScreen)
        let scanStarted = ContinuousClock.now
        _ = await observe()
        let scanSeconds = Double((ContinuousClock.now - scanStarted).components.seconds)
        let mainThreadGap = lastObserveMaxGapMs
        let extracted = lastTextPreview
        check("Vision OCR extracts the message", extracted.contains("KYC has expired") && extracted.contains("account may be blocked"), extracted.replacingOccurrences(of: "\n", with: "⏎"))
        check("URL survives OCR intact", extracted.contains(Self.fixtureURL))
        check("paragraph breaks preserved", extracted.contains("\n\n"))
        if expectBackend {
            if case .suspicious(let p) = state.coordinator.phase {
                check("local API analysed the OCR text", !p.isSample && p.tone == .danger, "score=\(p.riskScore ?? -1) category=\(p.categoryLabel ?? "-") scan≈\(Int(scanSeconds))s")
                // The main thread keeps running while the request is in flight (polls every 20 ms).
                check("UI stays responsive during analysis (main-thread gap < 250 ms)", mainThreadGap < 250, "max main-thread gap \(mainThreadGap) ms over a \(Int(scanSeconds)) s scan")
                if state.settings.configuration.effectiveAnalysisMode == .localOnly {
                    check("local-only mode: result says it was checked on this device only", p.source == "Checked on this device only.", p.source ?? "nil")
                } else {
                    // Remote-assisted: either the remote AI was used, or the card says why not (local result).
                    check("remote-assisted mode: result states whether the remote AI was used",
                          p.source == "Checked on this device + AI second opinion." || p.source?.hasPrefix("AI second opinion not used") == true, p.source ?? "nil")
                }
            } else {
                check("local API analysed the OCR text", false, kind(state.coordinator.phase))
            }
        } else {
            skip("local API analysed the OCR text", "run with EXPECT_BACKEND=1 and the local service started")
        }
        snapshot(state.scannerPanel.panel, "ocr-result")
        if expectBackend { await historyChecks() } else { skip("history records a real scan", "needs EXPECT_BACKEND=1") }
        state.closeScanner(reason: "self-test")
        await pause(200)

        // 6. Permission handling (state machine with the permission provider)
        for (status, expected) in [(ScreenCapturePermissionStatus.denied, "failed(permissionDenied)"), (.notRequested, "failed(permissionRequired)")] {
            state.dependencyOverride = { deps in
                var d = deps
                d.permission = PreviewPermission(status)
                return d
            }
            state.scan(.fullScreen)
            let s = await observe()
            check("permission \(status) → \(expected)", s.last == expected, s.joined(separator: " → "))
            if status == .denied { await pause(400); snapshot(state.scannerPanel.panel, "permission-denied") }
            state.closeScanner(reason: "self-test")
            await pause(150)
        }
        state.dependencyOverride = nil

        // 7. Real ScreenCaptureKit (only if permission already granted — never prompts in tests)
        if CGPreflightScreenCaptureAccess() {
            await realCaptureChecks()
        } else {
            skip("real ScreenCaptureKit capture (region)", "Screen Recording not granted to ScamShield")
            skip("real ScreenCaptureKit capture (full display)", "Screen Recording not granted to ScamShield")
        }

        // 8. No screenshots left behind
        let filesAfter = Self.imageFilesInTempLocations()
        check("no image files written", filesAfter.subtracting(filesBefore).isEmpty, "new: \(filesAfter.subtracting(filesBefore).count)")

        // 9. Hotkey, Settings
        check("global shortcut registered", state.settings.shortcutStatus == nil, state.settings.shortcut?.displayString ?? "off")
        state.dependencyOverride = { deps in
            var d = deps
            d.permission = PreviewPermission(.denied) // no real capture from a synthetic hotkey
            return d
        }
        if sendSyntheticHotkeyEvent() == noErr {
            await pause(100)
            check("hotkey event starts a scan", state.coordinator.phase != .idle, kind(state.coordinator.phase))
        } else {
            check("hotkey event starts a scan", false, "could not deliver synthetic event")
        }
        _ = await observe()
        state.closeScanner(reason: "self-test")
        state.dependencyOverride = nil

        state.openSettings()
        await pause(600)
        check("settings window opens", state.settingsWindow.window.isVisible)
        if expectBackend {
            await state.settings.testConnection()
            if case .online(let h) = state.settings.connection {
                check("local backend reachable", true, "status=\(h.status) llm=\(h.checks["llm"] ?? "?")")
                let gate = LocalOnlyGuard(api: state.makeAPI())
                do { try await gate.verify(); check("local-only gate: no cloud LLM active in backend", true, "llm=\(h.checks["llm"] ?? "?")") }
                catch { check("local-only gate: no cloud LLM active in backend", false, "\(error)") }
            } else {
                check("local backend reachable", false, "\(state.settings.connection)")
            }
        }
        snapshot(state.settingsWindow.window.contentView!, "settings")
        state.settingsWindow.window.close()
    }

    // MARK: Scanner window (drag handle, placement, single instance)

    private func waitVisible() async {
        for _ in 0..<100 where !state.scannerPanel.isVisible { await pause(20) }
    }

    /// Runs a scan to its result while sampling the card's origin at every phase.
    private func originsDuringScan(_ start: () -> Void) async -> (phases: [String], origins: Set<String>) {
        let panel = state.scannerPanel.panel
        var phases: [String] = [], origins = Set<String>()
        start()
        for _ in 0..<1500 {
            let k = kind(state.coordinator.phase)
            if phases.last != k { phases.append(k) }
            if panel.isVisible { origins.insert("\(panel.frame.origin)") }
            if state.coordinator.phase.isResult { break }
            await pause(20)
        }
        await pause(400) // result animation / SwiftUI updates
        origins.insert("\(panel.frame.origin)")
        return (phases, origins)
    }

    private func windowChecks() async {
        let controller = state.scannerPanel
        let panel = controller.panel
        check("scanner window uses ordinary floating level (not above menus, not on every Space)",
              panel.level == .floating && !panel.collectionBehavior.contains(.canJoinAllSpaces), "level=\(panel.level.rawValue)")

        // Drag handle: the header strip (and logo) start a window drag; the ✕ never does.
        state.preview(.critical)
        _ = await observe()
        await pause(450)
        if let content = panel.contentView, let frameView = content.superview {
            func hit(x: CGFloat, fromTop: CGFloat) -> NSView? {
                let y = content.isFlipped ? fromTop : content.bounds.height - fromTop
                return frameView.hitTest(content.convert(NSPoint(x: x, y: y), to: frameView))
            }
            let header = hit(x: 80, fromTop: 20)
            let close = hit(x: content.bounds.width - 26, fromTop: 26)
            check("header strip drags the window", header is WindowDragView, "\(header.map { String(describing: type(of: $0)) } ?? "nil")")
            check("close button is not a drag handle", close != nil && !(close is WindowDragView), "\(close.map { String(describing: type(of: $0)) } ?? "nil")")
        } else {
            check("header strip drags the window", false, "no content view")
        }
        state.closeScanner(reason: "self-test")
        await pause(200)

        await realEventDragChecks()

        // A move the controller didn't make (what a drag produces) is the user's placement.
        let visible = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        let placed = NSPoint(x: visible.minX + 37, y: visible.minY + 41)
        _ = await originsDuringScan { state.preview(.suspicious) } // card on screen, as when dragged
        panel.setFrameOrigin(placed)
        check("user move is remembered", controller.userOrigin == placed, "\(controller.userOrigin.map { "\($0)" } ?? "nil")")
        state.closeScanner(reason: "self-test")
        await pause(200)

        let run = await originsDuringScan { state.preview(.critical) }
        check("card reopens where the user left it and doesn't move while scanning",
              run.origins == ["\(placed)"], "\(run.phases.joined(separator: " → ")) origins=\(run.origins.sorted())")
        state.closeScanner(reason: "self-test")
        await pause(200)

        // Region scan: the card is hidden during selection, then must come back to the same spot.
        let recorder = RecordingCapture()
        state.dependencyOverride = { deps in
            var d = deps
            d.permission = PreviewPermission(.granted)
            d.capturer = recorder
            d.api = MockScamShieldAPI(scenario: .suspicious)
            d.analysisGate = nil
            return d
        }
        state.scan(.region)
        _ = await observe(until: { $0 == .selectingRegion }, timeoutMs: 3000)
        await pause(200)
        if let w = state.regionSelector.windows.first {
            w.selectionView.simulateDrag(from: CGPoint(x: 300, y: 300), to: CGPoint(x: 600, y: 450))
            let regionRun = await originsDuringScan { w.selectionView.confirmSelection() }
            check("card returns to the user's position after region selection",
                  regionRun.origins == ["\(placed)"], "\(regionRun.phases.joined(separator: " → ")) origins=\(regionRun.origins.sorted())")
        } else {
            check("card returns to the user's position after region selection", false, "no overlay")
        }
        state.dependencyOverride = nil

        // Opening the scanner again (menu actions / hotkey while showing or busy) reuses the window.
        menuBar.perform { self.state.preview(.safe) }
        await pause(100)
        state.scan(.fullScreen) // busy → shows the existing card
        _ = await observe()
        menuBar.perform { self.state.preview(.critical) }
        await pause(100) // perform() dispatches asynchronously; let the new scan start first
        _ = await observe()
        let scannerWindows = NSApp.windows.filter { $0 is ScannerPanel }
        check("menu bar reuses the single scanner window (no duplicates)", scannerWindows.count == 1 && panel.frame.origin == placed,
              "\(scannerWindows.count) scanner window(s), origin=\(panel.frame.origin)")
        state.closeScanner(reason: "self-test")
        await pause(200)

        // Display rearranged / disconnected while the card was hidden: it must come back on screen.
        let lost = NSPoint(x: visible.maxX + 5000, y: visible.minY)
        let hiddenBeforeMove = !panel.isVisible
        panel.setFrameOrigin(lost) // as if its display went away
        state.preview(.suspicious)
        await waitVisible()
        let header = NSRect(x: panel.frame.minX, y: panel.frame.maxY - ScannerView.dragHeaderHeight, width: panel.frame.width, height: ScannerView.dragHeaderHeight)
        check("card is brought back onto a connected display", hiddenBeforeMove && NSScreen.screens.contains { $0.visibleFrame.contains(header) },
              "was hidden=\(hiddenBeforeMove) origin=\(panel.frame.origin)")
        _ = await observe()
        state.closeScanner(reason: "self-test")
        await pause(200)
        panel.setFrameOrigin(placed)
    }

    // MARK: Phase 6 — resource cleanup after repeated scans

    static func residentMB() -> Double {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : -1
    }

    private func soakCheck() async {
        for _ in 0..<3 { state.preview(.critical); _ = await observe(); state.closeScanner(reason: "self-test") } // warm-up
        await pause(500)
        let before = Self.residentMB()
        let started = ContinuousClock.now
        var results = 0
        for i in 0..<25 {
            state.preview(i % 2 == 0 ? .critical : .safe)
            if await observe().last.map({ $0 == "critical" || $0 == "safe" }) == true { results += 1 }
            state.closeScanner(reason: "self-test")
            await pause(30)
        }
        await pause(800)
        let after = Self.residentMB()
        let secs = Double((ContinuousClock.now - started).components.attoseconds) / 1e18 + Double((ContinuousClock.now - started).components.seconds)
        let scannerWindows = NSApp.windows.filter { $0 is ScannerPanel }.count
        check("25 repeated scans: all complete, one window, memory stays bounded (< 40 MB growth)",
              results == 25 && scannerWindows == 1 && after - before < 40,
              String(format: "RSS %.1f → %.1f MB (+%.1f), %d/25 results, %d scanner window(s), %.1f s", before, after, after - before, results, scannerWindows, secs))
    }

    // MARK: Phase 5 — local history & reports (throw-away history dir for the self-test)

    private func historyChecks() async {
        let h = state.history
        // Six previews and two mock-API region scans ran before this; only the one real scan may be stored.
        check("previews / sample results are never recorded (only the real scan is in history)", h.entries.count == 1, "\(h.entries.count) entries")
        guard let e = h.entries.first, e.scanID == state.coordinator.scanID else {
            check("history records a real scan", false, "no entry for scan \(state.coordinator.scanID)")
            return
        }
        check("history records a real scan", e.riskLevel != .safe && e.linkHosts == ["sbi-kyc-update.xyz"], "\(e.riskLevel?.rawValue ?? "not assessed") score=\(e.riskScore.map(String.init) ?? "-") hosts=\(e.linkHosts)")
        let raw = (try? String(contentsOf: h.fileURL, encoding: .utf8)) ?? ""
        // The scanned text is saved (masked) by default; link paths/tokens are never stored.
        check("history saves the scanned text with link paths masked", !raw.isEmpty && (e.text ?? "").contains("KYC has expired") && !raw.contains("verify?id=42"),
              "\(raw.count) bytes")
        check("history stores why this colour (decision)", e.decision?.why.isEmpty == false, e.decision?.why ?? "nil")
        do {
            try state.reports.submit(.correct, for: e)
            let r = (try? String(contentsOf: state.reports.fileURL, encoding: .utf8)) ?? ""
            check("report saved locally without message text", state.reports.report(for: e.id)?.verdict == .correct && !r.contains("KYC has expired"), "provenance=\(state.reports.reports.first?.provenance ?? "-")")
        } catch {
            check("report saved locally without message text", false, "\(error)")
        }
        state.openHistory(selecting: e.id)
        state.openHistory(selecting: e.id)
        await pause(500)
        let windows = NSApp.windows.filter { $0.identifier?.rawValue == "scamshield.history" || $0.title == "ScamShield History" }
        check("History window opens (single instance) with the scan selected", windows.count == 1 && windows[0].isVisible && state.historyWindow.selection.selected == e.id, "\(windows.count) window(s)")
        if let w = windows.first { snapshot(w.contentView!, "history") ; w.close() }
    }

    // MARK: Real AppKit mouse events (routing is real; only pointer coordinates are scripted)

    /// A mouse event at a point of the card's content (x from the left, y from the top).
    private func mouseEvent(_ type: NSEvent.EventType, _ panel: NSWindow, x: CGFloat, fromTop: CGFloat) -> NSEvent? {
        guard let content = panel.contentView else { return nil }
        let p = content.convert(NSPoint(x: x, y: content.isFlipped ? fromTop : content.bounds.height - fromTop), to: nil)
        return NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                  pressure: type == .leftMouseUp ? 0 : 1)
    }

    /// Presses at (x, fromTop), moves the (scripted) pointer by `steps`, releases — every event
    /// delivered through `NSWindow.sendEvent`, so AppKit hit-testing through the SwiftUI hosting
    /// view decides which view receives it, exactly as for a physical mouse.
    private func drag(_ panel: NSWindow, x: CGFloat, fromTop: CGFloat, steps: [CGVector]) {
        var pointer = NSPoint(x: panel.frame.minX + x, y: panel.frame.maxY - fromTop)
        WindowDragView.pointerLocation = { pointer }
        defer { WindowDragView.pointerLocation = { NSEvent.mouseLocation } }
        if let e = mouseEvent(.leftMouseDown, panel, x: x, fromTop: fromTop) { panel.sendEvent(e) }
        for step in steps {
            pointer.x += step.dx; pointer.y += step.dy
            if let e = mouseEvent(.leftMouseDragged, panel, x: x, fromTop: fromTop) { panel.sendEvent(e) }
        }
        if let e = mouseEvent(.leftMouseUp, panel, x: x, fromTop: fromTop) { panel.sendEvent(e) }
    }

    private func click(_ panel: NSWindow, x: CGFloat, fromTop: CGFloat) {
        if let e = mouseEvent(.leftMouseDown, panel, x: x, fromTop: fromTop) { panel.sendEvent(e) }
        if let e = mouseEvent(.leftMouseUp, panel, x: x, fromTop: fromTop) { panel.sendEvent(e) }
    }

    private func realEventDragChecks() async {
        let controller = state.scannerPanel
        let panel = controller.panel
        // The panel keeps ignoring REAL clicks (they pass through to whatever is behind it), so a
        // person using the Mac can't disturb these checks. `NSWindow.sendEvent` below is unaffected:
        // it still routes each event through AppKit hit-testing and the SwiftUI hosting view.
        precondition(panel.ignoresMouseEvents)
        var drags = 0
        WindowDragView.onDragEnded = { _, _ in drags += 1 }
        defer { WindowDragView.onDragEnded = nil }

        // The scanner card must be its own movable window, never the menu-bar popover.
        menuBar.showPopover()
        for _ in 0..<60 where !menuBar.popover.isShown { await pause(50) }
        let popoverWindow = menuBar.popover.contentViewController?.view.window
        let popoverFrame = popoverWindow?.frame
        let button = menuBar.statusItem.button
        let buttonFrame = button.flatMap { b in b.window.map { $0.convertToScreen(b.convert(b.bounds, to: nil)) } }
        let anchored = popoverFrame.flatMap { pf in buttonFrame.map { bf in abs(pf.maxY - bf.minY) < 40 && pf.minX <= bf.maxX && pf.maxX >= bf.minX } } ?? false
        check("menu popover stays anchored to the menu-bar icon", anchored, "popover=\(popoverFrame.map { "\($0)" } ?? "nil") icon=\(buttonFrame.map { "\($0)" } ?? "nil")")
        check("scanner card is an independent window, not the popover", popoverWindow !== panel && panel.parent == nil && panel.styleMask.contains(.nonactivatingPanel))
        menuBar.closePopover()
        await pause(300)

        // Drag the header with real events in the middle of a scan (capture held for 3 s).
        state.dependencyOverride = { deps in
            var d = deps
            d.permission = PreviewPermission(.granted)
            d.capturer = SlowCapture(text: SelfTest.fixtureText, delay: .seconds(3))
            d.targets = PreviewTargets()
            d.api = MockScamShieldAPI(scenario: .critical)
            d.analysisGate = nil
            return d
        }
        state.scan(.fullScreen)
        _ = await observe(until: { if case .capturing = $0 { return true }; return false }, timeoutMs: 3000)
        await waitVisible()
        await pause(300)
        let keyBefore = panel.isKeyWindow
        let o0 = panel.frame.origin
        drag(panel, x: 90, fromTop: 20, steps: [CGVector(dx: -40, dy: -30), CGVector(dx: -80, dy: -60), CGVector(dx: -80, dy: -60)])
        let moved = NSPoint(x: o0.x - 200, y: o0.y - 150)
        check("header drag with real mouse events moves the actual window", panel.frame.origin == moved && drags == 1,
              "\(o0) → \(panel.frame.origin) (expected \(moved)), drag handler calls=\(drags)")
        check("dragging doesn't take keyboard focus", !keyBefore && !panel.isKeyWindow, "key before=\(keyBefore) after=\(panel.isKeyWindow)")
        check("dragged position is remembered", controller.userOrigin == moved)

        // Logo/title in the scanning animation is a handle too.
        if let content = panel.contentView, let frameView = content.superview {
            let midX = content.bounds.width / 2
            let logoY = stride(from: 120, through: 320, by: 10).map { CGFloat($0) }.first { y in
                frameView.hitTest(content.convert(NSPoint(x: midX, y: content.isFlipped ? y : content.bounds.height - y), to: frameView)) is WindowDragView
            }
            if let logoY {
                let before = panel.frame.origin
                drag(panel, x: midX, fromTop: logoY, steps: [CGVector(dx: 30, dy: 25)])
                check("logo drag with real mouse events moves the window", panel.frame.origin == NSPoint(x: before.x + 30, y: before.y + 25), "handle at y=\(logoY), \(before) → \(panel.frame.origin)")
            } else {
                check("logo drag with real mouse events moves the window", false, "no logo drag handle found")
            }
        }
        let placedByDrag = panel.frame.origin
        let run = await originsDuringScan {}
        check("position holds through OCR, analysis and the result", run.origins == ["\(placedByDrag)"], "\(run.phases.joined(separator: " → ")) origins=\(run.origins.sorted())")
        state.dependencyOverride = nil

        // ✕: pressing it and moving the pointer must not move the window; a click closes the card.
        let closeX = (panel.contentView?.bounds.width ?? ScannerView.size.width) - 26
        let beforeClose = panel.frame.origin
        drag(panel, x: closeX, fromTop: 26, steps: [CGVector(dx: -60, dy: -60)])
        check("close button never starts a drag", panel.frame.origin == beforeClose && drags == 2, "\(beforeClose) → \(panel.frame.origin)")
        if !panel.isVisible { state.preview(.critical); _ = await observe(); await pause(400) }
        click(panel, x: closeX, fromTop: 26)
        await pause(300)
        check("close button click (real mouse events) closes the card", !panel.isVisible && state.lastCloseReason.hasPrefix("close button"), state.lastCloseReason)

        // "Done" on a SAFE result is still clickable.
        state.preview(.safe)
        _ = await observe()
        await pause(500)
        let h = panel.contentView?.bounds.height ?? ScannerView.size.height
        let doneY = stride(from: h - 34, through: h - 70, by: -4).first { y in
            guard let content = panel.contentView, let fv = content.superview else { return false }
            let v = fv.hitTest(content.convert(NSPoint(x: content.bounds.width / 2, y: content.isFlipped ? y : content.bounds.height - y), to: fv))
            return v != nil && !(v is WindowDragView)
        } ?? (h - 50)
        click(panel, x: (panel.contentView?.bounds.width ?? 420) / 2, fromTop: doneY)
        await pause(300)
        check("result button (Done) click with real mouse events still works", !panel.isVisible, state.lastCloseReason)
        if panel.isVisible { state.closeScanner(reason: "self-test") }
        await pause(200)
    }

    private var lastTextPreview: String {
        textPreviewLog.last ?? ""
    }

    private var textPreviewLog: [String] = []

    private func realCaptureChecks() async {
        // A ScamShield-owned window showing a known message at a known place.
        guard let screen = NSScreen.main, let displayID = screen.displayID else { return }
        let window = NSWindow(contentRect: NSRect(x: screen.frame.minX + 120, y: screen.frame.minY + 160, width: 760, height: 360),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.level = .statusBar
        window.backgroundColor = .white
        let label = NSTextField(wrappingLabelWithString: Self.fixtureText)
        label.font = .systemFont(ofSize: 22)
        label.textColor = .black
        label.frame = NSRect(x: 24, y: 24, width: 712, height: 312)
        window.contentView?.addSubview(label)
        window.orderFrontRegardless()
        await pause(700)

        let local = CaptureGeometry.displayLocalRect(globalRect: window.frame, screenFrame: screen.frame)!
        let target = CaptureTarget(kind: .region, displayID: displayID, sourceRect: local, pointPixelScale: screen.backingScaleFactor)
        do {
            let image = try await ScreenCaptureService(excludeOwnApp: false).capture(target)
            let expected = CaptureGeometry.pixelSize(of: local, scale: screen.backingScaleFactor)
            let ocr = try await OCRService().recognizeText(in: image)
            check("real ScreenCaptureKit capture (region)", CGSize(width: image.pixelWidth, height: image.pixelHeight) == expected && ocr.text.contains(Self.fixtureURL),
                  "\(image.pixelWidth)×\(image.pixelHeight)px, url intact=\(ocr.text.contains(Self.fixtureURL))")
        } catch {
            check("real ScreenCaptureKit capture (region)", false, "\(error)")
        }
        window.orderOut(nil)

        let full = CaptureTarget(kind: .fullDisplay, displayID: displayID, sourceRect: CGRect(origin: .zero, size: screen.frame.size), pointPixelScale: screen.backingScaleFactor)
        do {
            let image = try await ScreenCaptureService().capture(full)
            let expected = CaptureGeometry.pixelSize(of: full.sourceRect, scale: screen.backingScaleFactor)
            check("real ScreenCaptureKit capture (full display)", CGSize(width: image.pixelWidth, height: image.pixelHeight) == expected, "\(image.pixelWidth)×\(image.pixelHeight)px")
        } catch {
            check("real ScreenCaptureKit capture (full display)", false, "\(error)")
        }
    }

    /// Image files in the app's temp/cache locations (screenshots must never be persisted).
    static func imageFilesInTempLocations() -> Set<String> {
        let fm = FileManager.default
        var dirs = [URL(fileURLWithPath: NSTemporaryDirectory())]
        if let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first { dirs.append(caches.appendingPathComponent("dev.scamshield.mac")) }
        var found = Set<String>()
        for dir in dirs {
            guard let e = fm.enumerator(at: dir, includingPropertiesForKeys: nil) else { continue }
            for case let url as URL in e where ["png", "jpg", "jpeg", "tiff", "heic", "bmp"].contains(url.pathExtension.lowercased()) {
                found.insert(url.path)
            }
        }
        return found
    }

    private func sendSyntheticHotkeyEvent() -> OSStatus {
        var event: EventRef?
        var status = CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kEventHotKeyPressed), 0, EventAttributes(kEventAttributeNone), &event)
        guard status == noErr, let event else { return status }
        defer { ReleaseEvent(event) }
        var id = EventHotKeyID(signature: 0x5353_4844, id: 1)
        status = SetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), MemoryLayout<EventHotKeyID>.size, &id)
        guard status == noErr else { return status }
        return SendEventToEventTarget(event, GetApplicationEventTarget())
    }

    private func snapshot(_ window: NSWindow, _ name: String) {
        if let view = window.contentView { snapshot(view, name) }
    }

    private func snapshot(_ view: NSView, _ name: String, scale: CGFloat = 1) {
        guard view.bounds.width > 0, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard var data = rep.representation(using: .png, properties: [:]) else { return }
        if scale != 1, let img = NSImage(data: data) {
            let size = NSSize(width: view.bounds.width * scale, height: view.bounds.height * scale)
            let small = NSImage(size: size)
            small.lockFocus()
            img.draw(in: NSRect(origin: .zero, size: size))
            small.unlockFocus()
            if let tiff = small.tiffRepresentation, let r = NSBitmapImageRep(data: tiff), let png = r.representation(using: .png, properties: [:]) { data = png }
        }
        try? data.write(to: out.appendingPathComponent("\(name).png"))
    }

    private func finish() {
        let failed = checks.filter { $0.status == "fail" }
        let report: [String: Any] = [
            "passed": failed.isEmpty,
            "total": checks.count,
            "failed": failed.count,
            "skipped": checks.filter { $0.status == "skipped" }.count,
            "checks": checks.map { ["name": $0.name, "status": $0.status, "passed": $0.status != "fail", "detail": $0.detail] },
            "userInput": userInput,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: out.appendingPathComponent("report.json"))
        }
        // Always leave through the real Quit path so "quit shuts down cleanly" is tested on its own
        // (it used to be skipped via exit(1) whenever any other check failed).
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor) }
        SelfTest.outputDirectory = out
        NSApp.terminate(nil)
    }
}

/// Holds the capture stage for `delay`, then returns a rendered fixture (no screen access).
struct SlowCapture: ScreenCapturing {
    let text: String
    let delay: Duration

    func capture(_ target: CaptureTarget) async throws -> CapturedImage {
        try? await Task.sleep(for: delay)
        guard let image = TextImageRenderer.render(text) else { throw CaptureError.failed }
        return CapturedImage(cgImage: image, target: target)
    }
}

/// Records capture targets and returns a rendered fixture (no screen access).
actor RecordingCapture: ScreenCapturing {
    private(set) var lastTarget: CaptureTarget?
    private(set) var count = 0

    func reset() { lastTarget = nil; count = 0 }

    nonisolated func capture(_ target: CaptureTarget) async throws -> CapturedImage {
        await record(target)
        guard let image = TextImageRenderer.render(SelfTest.fixtureText) else { throw CaptureError.failed }
        return CapturedImage(cgImage: image, target: target)
    }

    private func record(_ t: CaptureTarget) {
        lastTarget = t
        count += 1
    }
}

/// Returns a rendered image of `text` instead of capturing the screen.
struct FixtureCapture: ScreenCapturing {
    let text: String
    func capture(_ target: CaptureTarget) async throws -> CapturedImage {
        guard let image = TextImageRenderer.render(text) else { throw CaptureError.failed }
        return CapturedImage(cgImage: image, target: target)
    }
}
#endif
