import Foundation
import Testing
@testable import ScamShieldCore

private func freshDefaults() -> UserDefaults {
    let name = "scamshield.tests.\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}

@Suite("Configuration")
struct ConfigurationTests {
    @Test("local URLs are accepted and normalised", arguments: [
        ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
        ("  http://localhost:3000/ ", "http://localhost:3000"),
        ("HTTP://127.0.0.1:4000", "http://127.0.0.1:4000"),
        ("https://localhost:8443", "https://localhost:8443"),
        ("http://[::1]:3000", "http://[::1]:3000"),
    ])
    func accepts(input: String, expected: String) throws {
        #expect(try ConfigurationLoader.validateBaseURL(input).get().absoluteString == expected)
    }

    @Test("non-local or unsafe URLs are rejected", arguments: [
        ("https://api.scamshield.example", ConfigurationError.notLocal),
        ("http://192.168.1.10:3000", .notLocal),
        ("https://openrouter.ai/api/v1", .notLocal),
        ("ftp://127.0.0.1", .unsupportedScheme),
        ("file:///etc/passwd", .invalidURL),
        ("http://user:pw@127.0.0.1:3000", .hasCredentialsOrQuery),
        ("http://127.0.0.1:3000?x=1", .hasCredentialsOrQuery),
        ("not a url", .invalidURL),
        ("", .invalidURL),
    ])
    func rejects(input: String, error: ConfigurationError) {
        guard case .failure(let e) = ConfigurationLoader.validateBaseURL(input) else {
            Issue.record("accepted \(input)")
            return
        }
        #expect(e == error)
    }

    @Test("precedence: env > settings > Info.plist > defaults")
    func precedence() {
        let d = freshDefaults()
        let plist: [String: Any] = ["ScamShieldAPIBaseURL": "http://127.0.0.1:4000", "ScamShieldEnvironment": "production"]
        var c = ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: [:]).configuration
        #expect(c == AppConfiguration())

        c = ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: plist).configuration
        #expect(c.apiBaseURL.absoluteString == "http://127.0.0.1:4000")
        #expect(c.environment == .production)

        d.set("http://localhost:5000", forKey: ConfigurationKeys.defaultsAPIBaseURL)
        c = ConfigurationLoader.load(environment: [:], defaults: d, infoDictionary: plist).configuration
        #expect(c.apiBaseURL.absoluteString == "http://localhost:5000")

        c = ConfigurationLoader.load(environment: ["SCAMSHIELD_API_BASE_URL": "http://127.0.0.1:6000", "SCAMSHIELD_ENV": "development"], defaults: d, infoDictionary: plist).configuration
        #expect(c.apiBaseURL.absoluteString == "http://127.0.0.1:6000")
        #expect(c.environment == .development)
    }

    @Test("invalid values are reported, not applied")
    func problems() {
        let r = ConfigurationLoader.load(environment: ["SCAMSHIELD_API_BASE_URL": "https://evil.example", "SCAMSHIELD_ENV": "staging"], defaults: freshDefaults(), infoDictionary: [:])
        #expect(r.configuration.apiBaseURL == AppConfiguration.defaultAPIBaseURL)
        #expect(r.problems.count == 2)
    }

    @Test("default backend is local, never a remote/production host")
    func defaultIsLocal() {
        #expect(AppConfiguration.defaultAPIBaseURL.host == "127.0.0.1")
    }
}

@Suite("Hotkey")
struct HotkeyTests {
    @Test func defaultIsCommandShiftS() {
        #expect(HotkeyShortcut.default.displayString == "⇧⌘S")
        #expect(HotkeyShortcut.default.keyCode == 0x01) // kVK_ANSI_S
        #expect(HotkeyShortcut.default.carbonModifiers == 0x0100 | 0x0200) // cmdKey | shiftKey
    }

    @Test func displayOrderAndMasks() {
        let s = HotkeyShortcut(keyCode: 0x01, modifiers: [.command, .option, .control])
        #expect(s.displayString == "⌃⌥⌘S")
        #expect(s.carbonModifiers == 0x0100 | 0x0800 | 0x1000)
    }

    @Test func validity() {
        #expect(!HotkeyShortcut(keyCode: 0x01, modifiers: [.shift]).isValidGlobalShortcut)
        #expect(!HotkeyShortcut(keyCode: 0x01, modifiers: []).isValidGlobalShortcut)
        #expect(!HotkeyShortcut(keyCode: 0x7F, modifiers: [.command]).isValidGlobalShortcut)
        let allValid = HotkeyShortcut.presets.allSatisfy { $0.isValidGlobalShortcut }
        #expect(allValid)
        #expect(Set(HotkeyShortcut.presets).count == HotkeyShortcut.presets.count)
    }

    @Test func codableRoundTrip() throws {
        let s = HotkeyShortcut.presets[2]
        #expect(try JSONDecoder().decode(HotkeyShortcut.self, from: try JSONEncoder().encode(s)) == s)
    }
}

@MainActor
@Suite("Settings store")
struct SettingsStoreTests {
    struct StaticAPI: ScamShieldAPI {
        var health: Result<BackendHealth, ScamShieldAPIError>
        func scanMessage(_ text: String) async throws -> AnalysisSummary { throw ScamShieldAPIError.invalidResponse }
        func analyzeURL(_ url: String) async throws -> AnalysisSummary { throw ScamShieldAPIError.invalidResponse }
        func healthCheck() async throws -> BackendHealth { try health.get() }
    }

    @Test func defaultsAndPersistence() {
        let d = freshDefaults()
        let s = SettingsStore(defaults: d, environment: [:], infoDictionary: [:])
        #expect(s.shortcut == .default)
        s.setShortcut(HotkeyShortcut.presets[1])
        #expect(SettingsStore(defaults: d, environment: [:], infoDictionary: [:]).shortcut == HotkeyShortcut.presets[1])
        s.setShortcut(nil)
        #expect(SettingsStore(defaults: d, environment: [:], infoDictionary: [:]).shortcut == nil)
        s.setShortcut(HotkeyShortcut(keyCode: 0x01, modifiers: [.shift])) // invalid → ignored
        #expect(s.shortcut == nil)
    }

    @Test func savingURLValidatesAndNotifies() {
        let d = freshDefaults()
        let s = SettingsStore(defaults: d, environment: [:], infoDictionary: [:])
        var notified: AppConfiguration?
        s.onConfigurationChanged = { notified = $0 }
        s.apiBaseURLText = "https://example.com"
        #expect(!s.saveBaseURL())
        #expect(s.apiBaseURLError != nil)
        #expect(notified == nil)
        s.apiBaseURLText = "http://localhost:3001/"
        #expect(s.saveBaseURL())
        #expect(s.configuration.apiBaseURL.absoluteString == "http://localhost:3001")
        #expect(notified?.apiBaseURL.absoluteString == "http://localhost:3001")
        #expect(d.string(forKey: ConfigurationKeys.defaultsAPIBaseURL) == "http://localhost:3001")
    }

    @Test func connectionStatus() async {
        let online = SettingsStore(defaults: freshDefaults(), environment: [:], infoDictionary: [:], apiFactory: { _ in StaticAPI(health: .success(BackendHealth(status: "degraded", checks: [:], appVersion: "1"))) })
        await online.testConnection()
        #expect(online.connection == .online(BackendHealth(status: "degraded", checks: [:], appVersion: "1")))

        let offline = SettingsStore(defaults: freshDefaults(), environment: [:], infoDictionary: [:], apiFactory: { _ in StaticAPI(health: .failure(.backendUnreachable)) })
        await offline.testConnection()
        // Corrective fix: an exact, actionable message with the address (was a generic "isn't running").
        #expect(offline.connection == .offline("Nothing is answering at http://127.0.0.1:3000. Start the local services with: scripts/scamshield.sh start"))
    }
}
