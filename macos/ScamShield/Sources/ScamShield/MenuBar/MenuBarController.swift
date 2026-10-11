import AppKit
import SwiftUI
import ScamShieldCore
import ScamShieldUI

/// Owns the status-bar item and its popover.
///
/// Uses NSStatusItem + NSPopover rather than SwiftUI `MenuBarExtra(.window)` because the popover
/// must close programmatically after an action (e.g. before the scanner panel appears), which
/// MenuBarExtra does not expose.
@MainActor
final class MenuBarController: NSObject, NSPopoverDelegate {
    let statusItem: NSStatusItem
    let popover = NSPopover()
    private let state: AppState

    init(state: AppState) {
        self.state = state
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()

        if let button = statusItem.button {
            button.image = MenuBarIcon.image()
            button.toolTip = "ScamShield"
            button.setAccessibilityLabel("ScamShield")
            button.target = self
            button.action = #selector(togglePopover(_:))
        }

        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: MenuBarRoot(state: state, controller: self))
    }

    @objc func togglePopover(_ sender: Any?) {
        if popover.isShown { closePopover() } else { showPopover() }
    }

    func showPopover() {
        guard let button = statusItem.button else { return }
        state.refreshConnectionIfStale()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func closePopover() {
        popover.close()
    }

    // Diagnostics for the self-test.
    private(set) var popoverShowCount = 0
    private(set) var lastPopoverCloseReason = "none"

    func popoverDidShow(_ notification: Notification) {
        popoverShowCount += 1
    }

    func popoverWillClose(_ notification: Notification) {
        lastPopoverCloseReason = NSApp.currentEvent.map { "event type=\($0.type.rawValue)" } ?? "programmatic"
    }

    #if SCAMSHIELD_DEVTOOLS
    /// Developer UI captures: re-creates the menu content with one row shown highlighted.
    func rebuildContent(highlighting row: String?) {
        popover.contentViewController = NSHostingController(rootView: MenuBarRoot(state: state, controller: self, highlightedRow: row))
    }
    #endif

    /// Closes the popover, then runs the action (so windows it opens aren't covered by the popover).
    func perform(_ action: @escaping @MainActor () -> Void) {
        closePopover()
        DispatchQueue.main.async { action() }
    }
}

private struct MenuBarRoot: View {
    let state: AppState
    let controller: MenuBarController
    var highlightedRow: String? = nil

    var body: some View {
        MenuBarView(
            shortcut: state.settings.shortcut,
            connection: state.settings.connection,
            analysisMode: state.settings.configuration.effectiveAnalysisMode,
            highlightedRow: highlightedRow,
            actions: .init(
                scanScreen: { controller.perform { state.scan(.fullScreen) } },
                selectRegion: { controller.perform { state.scan(.region) } },
                openSettings: { controller.perform { state.openSettings() } },
                quit: { NSApp.terminate(nil) },
                openHistory: { controller.perform { state.openHistory() } },
                scanLink: { controller.perform { state.openLinkScan() } }
            )
        )
        .padding(.vertical, 2)
    }
}
