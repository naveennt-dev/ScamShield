import AppKit
import Observation
import SwiftUI
import ScamShieldCore
import ScamShieldUI

@MainActor
@Observable
final class HistorySelection {
    var selected: UUID?
}

/// The single History window (reused; never duplicated).
@MainActor
final class HistoryWindowController {
    let window: NSWindow
    let selection = HistorySelection()
    let ui = HistoryUIState()

    init(history: HistoryStore, reports: ReportStore, contributions: ContributionOutbox? = nil, onFeedbackSaved: @escaping () -> Void = {}) {
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: HistoryView.size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: true
        )
        window.title = "ScamShield History"
        window.isReleasedWhenClosed = false
        window.setAccessibilityIdentifier("scamshield.history")
        window.contentViewController = NSHostingController(rootView: HistoryRoot(history: history, reports: reports, selection: selection, ui: ui,
                                                                                 contributions: contributions, onFeedbackSaved: onFeedbackSaved))
        window.center()
    }

    func show(selecting id: UUID? = nil) {
        if let id { selection.selected = id }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }
}

private struct HistoryRoot: View {
    let history: HistoryStore
    let reports: ReportStore
    @Bindable var selection: HistorySelection
    let ui: HistoryUIState
    let contributions: ContributionOutbox?
    let onFeedbackSaved: () -> Void

    var body: some View {
        HistoryView(history: history, reports: reports, selection: $selection.selected, ui: ui,
                    contributions: contributions, onFeedbackSaved: onFeedbackSaved)
    }
}
