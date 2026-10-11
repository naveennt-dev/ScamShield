import AppKit
import SwiftUI
import ScamShieldCore
import ScamShieldUI

/// Borderless floating panel that hosts the scanner card. Non-activating, so opening it doesn't
/// pull focus away from the app the user was reading; Esc closes it (when it has focus).
final class ScannerPanel: NSPanel {
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}

/// Owns the single scanner window.
///
/// Placement: the card opens centred on the screen under the pointer until the user drags it
/// (header strip, logo or title). From then on it reopens exactly where they left it for the rest
/// of the app session, including after the card was hidden for region selection. If displays
/// change so that the header would be unreachable, it is moved back onto the nearest screen.
@MainActor
final class ScannerPanelController: NSObject, NSWindowDelegate {
    let panel: ScannerPanel
    private unowned let state: AppState
    /// Where the user last put the card (session only; nil = never moved → auto-centre).
    private(set) var userOrigin: NSPoint?
    /// True while this controller positions the panel, so only user moves update `userOrigin`.
    private var positioning = false
    private var screenObserver: NSObjectProtocol?

    init(state: AppState) {
        self.state = state
        panel = ScannerPanel(
            contentRect: NSRect(origin: .zero, size: ScannerView.size),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: true
        )
        super.init()
        panel.isFloatingPanel = true
        // Ordinary utility-panel level: above document windows, below menus, Spotlight, alerts
        // and the menu bar (was .statusBar, which sat on top of everything).
        panel.level = .floating
        // Opens on the Space the user is on instead of following them to every Space.
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // Dragging is done by explicit handles (`WindowDragArea`) so buttons never start a drag.
        panel.isMovableByWindowBackground = false
        // Clicking / dragging the card doesn't make it key; only results ask for focus.
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.title = "ScamShield Scanner"
        panel.setAccessibilityIdentifier("scamshield.scanner")
        panel.delegate = self
        panel.onCancel = { [weak state] in state?.closeScanner(reason: "panel cancelOperation (Esc)") }
        let host = NSHostingView(rootView: ScannerRoot(state: state))
        host.sizingOptions = [] // fixed-size card; SwiftUI updates must never resize/move the window
        panel.contentView = host
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.screensChanged() }
        }
    }

    var isVisible: Bool { panel.isVisible }

    /// Shows the card. `takeFocus` is true only for results: while a scan is running the card must
    /// never steal keyboard focus from the app the user is typing in (a stray Space/Return would
    /// otherwise land on the card's buttons). Already-visible cards are never repositioned.
    func show(takeFocus: Bool = false) {
        if !panel.isVisible { place() }
        panel.orderFrontRegardless()
        if takeFocus { panel.makeKey() }
    }

    func hide() {
        panel.orderOut(nil)
    }

    // MARK: Placement

    func windowDidMove(_ notification: Notification) {
        if !positioning { userOrigin = panel.frame.origin }
    }

    private func place() {
        if let origin = userOrigin {
            setOrigin(reachableOrigin(for: NSRect(origin: origin, size: panel.frame.size), screens: NSScreen.screens.map(\.visibleFrame)) ?? origin)
        } else {
            center()
        }
    }

    /// Centres on the screen under the mouse pointer (the screen the user is looking at).
    private func center() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let size = panel.frame.size
        setOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2 + visible.height * 0.08))
    }

    private func setOrigin(_ origin: NSPoint) {
        guard origin != panel.frame.origin else { return }
        positioning = true
        panel.setFrameOrigin(origin)
        positioning = false
    }

    private func reachableOrigin(for frame: NSRect, screens: [NSRect]) -> NSPoint? {
        PanelPlacement.reachableOrigin(for: frame, screens: screens, headerHeight: ScannerView.dragHeaderHeight)
    }

    private func screensChanged() {
        let frames = NSScreen.screens.map(\.visibleFrame)
        if panel.isVisible, let fixed = reachableOrigin(for: panel.frame, screens: frames) {
            setOrigin(fixed)
            if userOrigin != nil { userOrigin = fixed }
        } else if let origin = userOrigin, let fixed = reachableOrigin(for: NSRect(origin: origin, size: panel.frame.size), screens: frames) {
            userOrigin = fixed
        }
    }
}

/// Binds the coordinator to the view and handles the quiet auto-dismiss of SAFE results.
private struct ScannerRoot: View {
    let state: AppState
    /// Long enough to read why it was judged safe (the details stay in History).
    static let safeAutoDismiss: Duration = .seconds(8)

    var body: some View {
        ScannerView(
            phase: state.coordinator.phase,
            ocrPreparing: !state.ocrReady,
            onClose: {
                let e = NSApp.currentEvent
                let detail = e.map { "type=\($0.type.rawValue) at=\(NSEvent.mouseLocation) clicks=\($0.type == .leftMouseUp || $0.type == .leftMouseDown ? $0.clickCount : -1) keyCode=\($0.type == .keyDown ? Int($0.keyCode) : -1)" } ?? "no event"
                state.closeScanner(reason: "close button [\(detail)]")
            },
            onScanAgain: { state.scan(state.lastMode) },
            onOpenSettings: {
                state.openScreenRecordingSettings()
                state.closeScanner(reason: "open settings")
            },
            onShowHistory: state.history.isEnabled ? { state.openHistory(selecting: state.lastHistoryEntryID) } : nil
        )
        .task(id: isSafe) {
            guard isSafe else { return }
            try? await Task.sleep(for: Self.safeAutoDismiss)
            if isSafe { state.closeScanner(reason: "safe auto-dismiss") }
        }
    }

    private var isSafe: Bool {
        if case .safe = state.coordinator.phase { return true }
        return false
    }
}
