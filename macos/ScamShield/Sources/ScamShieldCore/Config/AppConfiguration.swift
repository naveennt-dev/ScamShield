import Foundation

/// Runtime configuration for the macOS client.
///
/// Precedence (highest first):
///   1. Process environment (`SCAMSHIELD_API_BASE_URL`, `SCAMSHIELD_ENV`)
///   2. User overrides saved from Settings (UserDefaults)
///   3. Bundle Info.plist keys (`ScamShieldAPIBaseURL`, `ScamShieldEnvironment`)
///   4. Built-in development defaults
///
/// No secrets belong here. The app never talks to OpenRouter; it only talks to the local
/// ScamShield backend, which holds any credentials.
/// Where a scan may be analysed (Phase 4). The app itself only ever talks to the local service;
/// in `.remoteAssisted` it asks that service to ALSO consult a remote AI for this scan.
public enum AnalysisMode: String, Sendable, CaseIterable, Codable {
    /// Nothing leaves this Mac: OCR, rules, ML and scoring all run locally (always used until the user consents to AI).
    case localOnly = "local"
    /// Default for new installs once consented: the local service also sends masked OCR text (never images) to a free OpenRouter model.
    case remoteAssisted = "remote-assisted"
}

public struct AppConfiguration: Sendable, Equatable {
    public enum Environment: String, Sendable, CaseIterable {
        case development, production
    }

    public static let defaultAPIBaseURL = URL(string: "http://127.0.0.1:3000")!

    public var apiBaseURL: URL
    public var environment: Environment
    /// The chosen mode. New installations default to `.remoteAssisted` (AI second opinion), but it
    /// only takes effect after the user has agreed on the consent screen — see `effectiveAnalysisMode`.
    public var analysisMode: AnalysisMode
    /// The user's answer on the AI consent screen (nil = not asked yet).
    public var remoteConsent: Bool?

    /// What scans actually use: remote-assisted only with an explicit "yes"; otherwise on this Mac only.
    public var effectiveAnalysisMode: AnalysisMode {
        analysisMode == .remoteAssisted && remoteConsent == true ? .remoteAssisted : .localOnly
    }

    public init(apiBaseURL: URL = AppConfiguration.defaultAPIBaseURL, environment: Environment = .development, analysisMode: AnalysisMode = .remoteAssisted, remoteConsent: Bool? = nil) {
        self.remoteConsent = remoteConsent
        self.apiBaseURL = apiBaseURL
        self.environment = environment
        self.analysisMode = analysisMode
    }
}

public enum ConfigurationError: Error, Equatable, LocalizedError, Sendable {
    case invalidURL
    case unsupportedScheme
    case notLocal
    case hasCredentialsOrQuery

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Enter a valid URL such as http://127.0.0.1:3000."
        case .unsupportedScheme: return "Only http and https are supported."
        case .notLocal: return "ScamShield only connects to a backend on this device (127.0.0.1, localhost or ::1)."
        case .hasCredentialsOrQuery: return "The URL must not contain a username, password, query or fragment."
        }
    }
}

public enum ConfigurationKeys {
    public static let envAPIBaseURL = "SCAMSHIELD_API_BASE_URL"
    public static let envEnvironment = "SCAMSHIELD_ENV"
    public static let plistAPIBaseURL = "ScamShieldAPIBaseURL"
    public static let plistEnvironment = "ScamShieldEnvironment"
    public static let defaultsAPIBaseURL = "apiBaseURL"
    public static let defaultsAnalysisMode = "analysisMode"
    public static let defaultsRemoteConsent = "remoteAIConsent"
}

public enum ConfigurationLoader {
    /// Local-first policy: the client may only reach a backend on the loopback interface.
    public static func validateBaseURL(_ raw: String) -> Result<URL, ConfigurationError> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed), let scheme = comps.scheme?.lowercased(), let host = comps.host?.lowercased(), !host.isEmpty else {
            return .failure(.invalidURL)
        }
        guard scheme == "http" || scheme == "https" else { return .failure(.unsupportedScheme) }
        guard comps.user == nil, comps.password == nil, comps.query == nil, comps.fragment == nil else {
            return .failure(.hasCredentialsOrQuery)
        }
        let loopback: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]
        guard loopback.contains(host) else { return .failure(.notLocal) }
        var normalized = comps
        normalized.scheme = scheme
        if normalized.path.hasSuffix("/") { normalized.path.removeLast() }
        guard let url = normalized.url else { return .failure(.invalidURL) }
        return .success(url)
    }

    private static func parseBool(_ v: Any?) -> Bool? {
        switch v {
        case let b as Bool: return b
        case let n as NSNumber: return n.boolValue
        case let s as String:
            switch s.lowercased() {
            case "1", "true", "yes": return true
            case "0", "false", "no": return false
            default: return nil
            }
        default: return nil
        }
    }

    /// Builds the effective configuration. Invalid values at any level are skipped (and reported
    /// in `problems`) rather than crashing the app.
    public static func load(
        environment env: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard,
        infoDictionary: [String: Any] = Bundle.main.infoDictionary ?? [:]
    ) -> (configuration: AppConfiguration, problems: [String]) {
        var config = AppConfiguration()
        var problems: [String] = []

        func applyURL(_ raw: String?, source: String) {
            guard let raw, !raw.isEmpty else { return }
            switch validateBaseURL(raw) {
            case .success(let url): config.apiBaseURL = url
            case .failure(let e): problems.append("\(source): \(e.localizedDescription)")
            }
        }

        // Lowest → highest precedence.
        applyURL(infoDictionary[ConfigurationKeys.plistAPIBaseURL] as? String, source: "Info.plist")
        if let e = (infoDictionary[ConfigurationKeys.plistEnvironment] as? String).flatMap(AppConfiguration.Environment.init(rawValue:)) {
            config.environment = e
        }

        applyURL(defaults.string(forKey: ConfigurationKeys.defaultsAPIBaseURL), source: "Settings")
        // Only an explicit choice saved from Settings can enable remote analysis (no env/plist path).
        if let m = defaults.string(forKey: ConfigurationKeys.defaultsAnalysisMode).flatMap(AnalysisMode.init(rawValue:)) {
            config.analysisMode = m
        }
        if defaults.object(forKey: ConfigurationKeys.defaultsRemoteConsent) != nil {
            config.remoteConsent = defaults.bool(forKey: ConfigurationKeys.defaultsRemoteConsent)
        }

        applyURL(env[ConfigurationKeys.envAPIBaseURL], source: ConfigurationKeys.envAPIBaseURL)
        if let raw = env[ConfigurationKeys.envEnvironment] {
            if let e = AppConfiguration.Environment(rawValue: raw.lowercased()) { config.environment = e }
            else { problems.append("\(ConfigurationKeys.envEnvironment): unknown value") }
        }

        return (config, problems)
    }
}
