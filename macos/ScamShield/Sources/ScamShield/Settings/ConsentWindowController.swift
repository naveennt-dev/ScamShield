import AppKit
import SwiftUI
import ScamShieldCore
import ScamShieldUI

/// Shows the AI second-opinion consent once (first launch, or until answered).
@MainActor
final class ConsentWindowController {
    private var window: NSWindow?

    func showIfNeeded(store: SettingsStore) {
        guard store.configuration.remoteConsent == nil, window == nil else { return }
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: ConsentView.size), styleMask: [.titled], backing: .buffered, defer: false)
        w.title = "ScamShield"
        w.isReleasedWhenClosed = false
        w.contentViewController = NSHostingController(rootView: ConsentView { [weak self, weak store] granted in
            store?.recordRemoteConsent(granted)
            self?.window?.close()
            self?.window = nil
        })
        w.center()
        window = w
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
    }
}
