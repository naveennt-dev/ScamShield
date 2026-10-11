import AppKit
import SwiftUI
import ScamShieldCore
import ScamShieldUI

/// The single "Scan Link" window.
@MainActor
final class LinkScanWindowController {
    private var window: NSWindow?
    private let state: AppState
    private lazy var model = LinkScanModel(
        client: { [unowned self] in
            LinkScanClient(baseURL: self.state.settings.configuration.apiBaseURL, analysisMode: self.state.settings.configuration.effectiveAnalysisMode)
        },
        onReport: { [unowned self] r in
            self.state.history.recordLink(r, mode: self.state.settings.configuration.effectiveAnalysisMode)
        })

    init(state: AppState) { self.state = state }

    func show() {
        let settings = state.settings
        let root = LinkScanRoot(model: model, settings: settings)
        if window == nil {
            let w = NSWindow(contentRect: NSRect(origin: .zero, size: LinkScanView.size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: true)
            w.title = "Scan Link"
            w.isReleasedWhenClosed = false
            w.setAccessibilityIdentifier("scamshield.linkscan")
            w.center()
            window = w
        }
        window?.contentViewController = NSHostingController(rootView: root)
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }
}

private struct LinkScanRoot: View {
    let model: LinkScanModel
    @Bindable var settings: SettingsStore
    var body: some View {
        LinkScanView(model: model, online: settings.configuration.effectiveAnalysisMode == .remoteAssisted, inspectionAllowed: settings.linkInspectionEnabled)
    }
}
