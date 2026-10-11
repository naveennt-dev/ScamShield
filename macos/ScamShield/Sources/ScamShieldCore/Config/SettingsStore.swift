import Foundation
import Observation

public enum ConnectionStatus: Equatable, Sendable {
    case unknown
    case checking
    case online(BackendHealth)
    case offline(String)
}

/// User-editable settings, persisted in UserDefaults. Holds no secrets.
@MainActor
@Observable
public final class SettingsStore {
    public private(set) var configuration: AppConfiguration
    public var apiBaseURLText: String
    public private(set) var apiBaseURLError: String?
    public private(set) var shortcut: HotkeyShortcut?
    /// Set by the app after trying to register the shortcut (e.g. "already used by another app").
    public var shortcutStatus: String?
    public private(set) var connection: ConnectionStatus = .unknown
    public let environmentOverridesURL: Bool
    public let loadProblems: [String]

    @ObservationIgnored public var onConfigurationChanged: ((AppConfiguration) -> Void)?
    @ObservationIgnored public var onShortcutChanged: ((HotkeyShortcut?) -> Void)?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let apiFactory: @Sendable (URL) -> any ScamShieldAPI

    static let shortcutKey = "globalShortcut"
    static let shortcutDisabledKey = "globalShortcutDisabled"

    public init(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        infoDictionary: [String: Any] = Bundle.main.infoDictionary ?? [:],
        apiFactory: @escaping @Sendable (URL) -> any ScamShieldAPI = { LocalScamShieldAPI(baseURL: $0, timeout: 5) }
    ) {
        let loaded = ConfigurationLoader.load(environment: environment, defaults: defaults, infoDictionary: infoDictionary)
        self.defaults = defaults
        self.apiFactory = apiFactory
        self.configuration = loaded.configuration
        self.loadProblems = loaded.problems
        self.apiBaseURLText = loaded.configuration.apiBaseURL.absoluteString
        self.environmentOverridesURL = environment[ConfigurationKeys.envAPIBaseURL] != nil

        if defaults.bool(forKey: Self.shortcutDisabledKey) {
            shortcut = nil
        } else if let data = defaults.data(forKey: Self.shortcutKey),
                  let saved = try? JSONDecoder().decode(HotkeyShortcut.self, from: data),
                  saved.isValidGlobalShortcut {
            shortcut = saved
        } else {
            shortcut = .default
        }
    }

    /// Validates and saves the backend URL (loopback only). Returns true on success.
    @discardableResult
    public func saveBaseURL() -> Bool {
        switch ConfigurationLoader.validateBaseURL(apiBaseURLText) {
        case .success(let url):
            apiBaseURLError = nil
            apiBaseURLText = url.absoluteString
            defaults.set(url.absoluteString, forKey: ConfigurationKeys.defaultsAPIBaseURL)
            if !environmentOverridesURL { configuration.apiBaseURL = url }
            connection = .unknown
            onConfigurationChanged?(configuration)
            return true
        case .failure(let e):
            apiBaseURLError = e.localizedDescription
            return false
        }
    }


    /// The user's explicit choice; `.localOnly` unless they turned remote analysis on here.
    public func setAnalysisMode(_ mode: AnalysisMode) {
        configuration.analysisMode = mode
        defaults.set(mode.rawValue, forKey: ConfigurationKeys.defaultsAnalysisMode)
        // Choosing "On this Mac + AI" in Settings is an explicit agreement to send the text.
        if mode == .remoteAssisted {
            configuration.remoteConsent = true
            defaults.set(true, forKey: ConfigurationKeys.defaultsRemoteConsent)
        }
        onConfigurationChanged?(configuration)
    }

    /// The answer on the first-launch AI consent screen.
    public func recordRemoteConsent(_ granted: Bool) {
        configuration.remoteConsent = granted
        defaults.set(granted, forKey: ConfigurationKeys.defaultsRemoteConsent)
        configuration.analysisMode = granted ? .remoteAssisted : .localOnly
        defaults.set(configuration.analysisMode.rawValue, forKey: ConfigurationKeys.defaultsAnalysisMode)
        onConfigurationChanged?(configuration)
    }

    public func setShortcut(_ s: HotkeyShortcut?) {
        guard s == nil || s!.isValidGlobalShortcut else { return }
        shortcut = s
        if let s, let data = try? JSONEncoder().encode(s) {
            defaults.set(data, forKey: Self.shortcutKey)
            defaults.set(false, forKey: Self.shortcutDisabledKey)
        } else {
            defaults.set(true, forKey: Self.shortcutDisabledKey)
        }
        onShortcutChanged?(s)
    }

    /// Calls `GET /api/v1/health` on the configured local backend.
    public func testConnection() async {
        connection = .checking
        let url = configuration.apiBaseURL.absoluteString
        do {
            let health = try await apiFactory(configuration.apiBaseURL).healthCheck()
            connection = .online(health)
        } catch let e as ScamShieldAPIError {
            connection = .offline(Self.describe(e, url: url))
        } catch {
            connection = .offline("Couldn't check \(url): \(error.localizedDescription)")
        }
        lastChecked = now()
    }

    /// When the connection was last checked (Settings re-checks every time it opens).
    public private(set) var lastChecked: Date?
    /// Screen Recording permission as last seen by the app ("granted" / "not granted"), for Settings.
    public var screenRecordingStatus: String?
    /// "Inspect page behaviour" in Scan Link (isolated browser). Off by default (release audit: the
    /// isolation is not a VM). On = the button is offered; each inspection still needs its own click.
    public var linkInspectionEnabled: Bool {
        get { access(keyPath: \.linkInspectionEnabled); return defaults.object(forKey: Self.linkInspectionKey) as? Bool ?? false }
        set { withMutation(keyPath: \.linkInspectionEnabled) { defaults.set(newValue, forKey: Self.linkInspectionKey) } }
    }
    static let linkInspectionKey = "linkInspectionEnabled"
    @ObservationIgnored public var now: () -> Date = Date.init

    /// Accurate, actionable connection errors (the old text said "isn't running" even for timeouts).
    public static func describe(_ e: ScamShieldAPIError, url: String) -> String {
        switch e {
        case .backendUnreachable: return "Nothing is answering at \(url). Start the local services with: scripts/scamshield.sh start"
        case .timedOut: return "The service at \(url) is running but didn't answer in time. Try again; if it persists, run scripts/scamshield.sh restart"
        case .invalidResponse: return "Something answered at \(url), but it isn't the ScamShield service (unexpected response). Check the Backend URL and port."
        case .rateLimited: return "The service at \(url) is running but busy (rate limited). Try again in a minute."
        case .server(_, let message): return "The service at \(url) reported an error: \(message)"
        case .emptyInput: return "Unexpected client error."
        }
    }
}
