import AppKit
import SwiftUI
import ScamShieldCore
import ScamShieldUI

@MainActor
final class SettingsWindowController {
    let window: NSWindow

    private let store: SettingsStore

    init(store: SettingsStore) {
        self.store = store
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: SettingsView.size),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: true
        )
        window.title = "ScamShield Settings"
        window.isReleasedWhenClosed = false
        window.setAccessibilityIdentifier("scamshield.settings")
        window.contentViewController = NSHostingController(rootView: SettingsView(store: store))
        window.center()
    }

    func show() {
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        // Never show a stale status: check the service every time Settings opens.
        let store = self.store
        store.screenRecordingStatus = CGPreflightScreenCaptureAccess() ? "granted" : "not granted"
        Task { await store.testConnection() }
    }
}
