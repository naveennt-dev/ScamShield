import AppKit
import Foundation
import Testing
@testable import ScamShieldCore

/// "Keep the scanner above other windows" — both states, persistence and the change callback.
/// (The running panel's real level in both states is checked by the app self-test.)
@MainActor
struct ScannerWindowPolicyTests {
    private func defaults() -> UserDefaults {
        let name = "scamshield.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func onUsesTheFloatingUtilityLevel() {
        #expect(ScannerWindowPolicy.level(alwaysOnTop: true) == .floating)
        // Never above menus, alerts or the menu bar.
        #expect(ScannerWindowPolicy.level(alwaysOnTop: true) < .statusBar)
        #expect(ScannerWindowPolicy.level(alwaysOnTop: true) < .modalPanel)
    }

    @Test func offUsesTheOrdinaryWindowLevel() {
        #expect(ScannerWindowPolicy.level(alwaysOnTop: false) == .normal)
        #expect(ScannerWindowPolicy.level(alwaysOnTop: false) < ScannerWindowPolicy.level(alwaysOnTop: true))
    }

    @Test func settingDefaultsToOn() {
        let store = SettingsStore(defaults: defaults(), environment: [:], infoDictionary: [:])
        #expect(store.scannerAlwaysOnTop == true)
    }

    @Test func turningOffAndOnIsPersistedAndAnnounced() {
        let d = defaults()
        let store = SettingsStore(defaults: d, environment: [:], infoDictionary: [:])
        var announced: [Bool] = []
        store.onScannerLevelChanged = { announced.append($0) }

        store.scannerAlwaysOnTop = false
        #expect(store.scannerAlwaysOnTop == false)
        #expect(SettingsStore(defaults: d, environment: [:], infoDictionary: [:]).scannerAlwaysOnTop == false)

        store.scannerAlwaysOnTop = true
        #expect(store.scannerAlwaysOnTop == true)
        #expect(SettingsStore(defaults: d, environment: [:], infoDictionary: [:]).scannerAlwaysOnTop == true)

        #expect(announced == [false, true])
        #expect(announced.map(ScannerWindowPolicy.level(alwaysOnTop:)) == [.normal, .floating])
    }
}
