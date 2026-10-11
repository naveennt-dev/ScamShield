import Foundation
import Testing
@testable import ScamShieldCore

@MainActor
struct ConsentTests {
    private func defaults() -> UserDefaults {
        let name = "consent.test.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func newInstallDefaultsToAIButStaysLocalUntilConsent() {
        let c = ConfigurationLoader.load(environment: [:], defaults: defaults(), infoDictionary: [:]).configuration
        #expect(c.analysisMode == .remoteAssisted)
        #expect(c.remoteConsent == nil)
        #expect(c.effectiveAnalysisMode == .localOnly) // nothing leaves the Mac before the user agrees
    }

    @Test func consentAnswerIsPersistedAndApplied() {
        let d = defaults()
        let store = SettingsStore(defaults: d, environment: [:], infoDictionary: [:])
        store.recordRemoteConsent(true)
        #expect(store.configuration.effectiveAnalysisMode == .remoteAssisted)
        var c = ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: [:]).configuration
        #expect(c.remoteConsent == true && c.effectiveAnalysisMode == .remoteAssisted)

        store.recordRemoteConsent(false)
        c = ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: [:]).configuration
        #expect(c.remoteConsent == false && c.effectiveAnalysisMode == .localOnly)
    }

    @Test func declinedConsentNeverSendsEvenIfModeSaysRemote() {
        var c = AppConfiguration(analysisMode: .remoteAssisted, remoteConsent: false)
        #expect(c.effectiveAnalysisMode == .localOnly)
        c.remoteConsent = true
        #expect(c.effectiveAnalysisMode == .remoteAssisted)
    }
}
