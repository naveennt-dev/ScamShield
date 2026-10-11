import Foundation
import Observation
import os
import Security

/// Where the bundled engine lives inside the app (Contents/Resources/engine).
public struct EngineLayout: Sendable, Equatable {
    public var node: URL
    public var serverScript: URL
    public var workingDirectory: URL

    public init(node: URL, serverScript: URL, workingDirectory: URL) {
        self.node = node
        self.serverScript = serverScript
        self.workingDirectory = workingDirectory
    }

    /// nil when the app was built without the engine (developer builds that use scripts/scamshield.sh).
    public static func bundled(in bundle: Bundle = .main) -> EngineLayout? {
        guard let res = bundle.resourceURL?.appendingPathComponent("engine") else { return nil }
        let node = res.appendingPathComponent("node"), app = res.appendingPathComponent("app")
        let script = app.appendingPathComponent("server.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: script.path) else { return nil }
        return EngineLayout(node: node, serverScript: script, workingDirectory: app)
    }
}

/// What answers on the engine's address.
public enum EngineProbe: Sendable, Equatable {
    case scamShield(edition: String?)
    case otherProgram
    case nothing
}

public enum EngineState: Sendable, Equatable {
    case idle
    case starting
    /// managed = this app started the engine; false = an already-running ScamShield service is used.
    case running(managed: Bool)
    case failed(String)
}

/// A running engine process (abstracted so tests can use fakes).
public protocol EngineProcess: AnyObject, Sendable {
    var isRunning: Bool { get }
    func terminate()
    func kill()
}

public typealias EngineLauncher = @Sendable (_ layout: EngineLayout, _ environment: [String: String], _ log: URL, _ onExit: @escaping @Sendable (Int32) -> Void) throws -> EngineProcess

/// Starts, watches and stops the on-device ScamShield Engine — no Terminal needed.
///
///  - If a ScamShield service already answers on the configured address (e.g. the developer stack),
///    it is used and nothing is started.
///  - Otherwise the bundled engine is started bound to 127.0.0.1, with a minimal environment: no
///    database, no Redis, no Python; the optional AI key comes from the Keychain, never from disk.
///  - It is restarted after an unexpected exit (at most 3 times in 2 minutes) and stopped on quit.
///    The engine also exits by itself if this app disappears (SCAMSHIELD_PARENT_PID).
@MainActor
@Observable
public final class EngineManager {
    public private(set) var state: EngineState = .idle

    @ObservationIgnored public let baseURL: URL
    @ObservationIgnored private let layout: EngineLayout?
    @ObservationIgnored private let logURL: URL
    @ObservationIgnored private let probe: @Sendable (URL) async -> EngineProbe
    @ObservationIgnored private let launcher: EngineLauncher
    @ObservationIgnored private let environmentProvider: @MainActor () -> [String: String]
    @ObservationIgnored private let startupTimeout: Duration
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored private var process: EngineProcess?
    @ObservationIgnored private var stopping = false
    @ObservationIgnored private var restarts: [Date] = []
    @ObservationIgnored private static let log = Logger(subsystem: "dev.scamshield.mac", category: "engine")

    public init(
        baseURL: URL,
        layout: EngineLayout?,
        logURL: URL,
        probe: @escaping @Sendable (URL) async -> EngineProbe = EngineManager.httpProbe,
        launcher: @escaping EngineLauncher = EngineManager.foundationLauncher,
        environment: @escaping @MainActor () -> [String: String],
        startupTimeout: Duration = .seconds(30),
        pollInterval: Duration = .milliseconds(300)
    ) {
        self.baseURL = baseURL
        self.layout = layout
        self.logURL = logURL
        self.probe = probe
        self.launcher = launcher
        self.environmentProvider = environment
        self.startupTimeout = startupTimeout
        self.pollInterval = pollInterval
    }

    public var isRunning: Bool { if case .running = state { return true } else { return false } }

    public func start() async {
        if case .starting = state { return }
        if isRunning, process?.isRunning ?? true { return }
        stopping = false
        state = .starting
        switch await probe(baseURL) {
        case .scamShield:
            Self.log.notice("using the ScamShield service already running")
            state = .running(managed: false)
            return
        case .otherProgram:
            state = .failed("Another program is using \(baseURL.host() ?? "127.0.0.1"):\(baseURL.port ?? 3000), which ScamShield needs. Quit that program and try again.")
            return
        case .nothing:
            break
        }
        guard let layout else {
            state = .failed("The analysis engine is missing from this copy of ScamShield. Reinstall the app.")
            return
        }
        do {
            try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            Self.rotate(logURL)
            process = try launcher(layout, environmentProvider(), logURL) { [weak self] status in
                Task { @MainActor in self?.processExited(status) }
            }
        } catch {
            state = .failed("The analysis engine could not start (\(error.localizedDescription)).")
            return
        }
        let deadline = ContinuousClock.now + startupTimeout
        while ContinuousClock.now < deadline {
            if case .scamShield = await probe(baseURL) {
                Self.log.notice("engine started")
                state = .running(managed: true)
                return
            }
            if process?.isRunning == false { break }
            try? await Task.sleep(for: pollInterval)
        }
        process?.kill()
        process = nil
        state = .failed("The analysis engine did not start in time. Details: \(logURL.path)")
    }

    public func stop() {
        stopping = true
        guard let p = process else { state = .idle; return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { p.kill() }
        process = nil
        state = .idle
    }

    private func processExited(_ status: Int32) {
        process = nil
        guard !stopping else { return }
        Self.log.error("engine exited unexpectedly (status \(status, privacy: .public))")
        let now = Date()
        restarts = restarts.filter { now.timeIntervalSince($0) < 120 } + [now]
        if restarts.count > 3 {
            state = .failed("The analysis engine keeps stopping. Details: \(logURL.path)")
            return
        }
        state = .idle
        Task { await start() }
    }

    /// Keep the engine log small (it never contains message text — IDs, scores and statuses only).
    static func rotate(_ url: URL) {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        if size > 5_000_000 {
            try? FileManager.default.removeItem(at: url.appendingPathExtension("1"))
            try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("1"))
        }
    }

    // MARK: - Real implementations

    public static let httpProbe: @Sendable (URL) async -> EngineProbe = { base in
        var req = URLRequest(url: base.appending(path: "api/v1/health"), timeoutInterval: 1.5)
        req.httpShouldHandleCookies = false
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        guard let (data, response) = try? await URLSession(configuration: config).data(for: req) else { return .nothing }
        struct Health: Decodable { struct D: Decodable { let status: String; let checks: [String: String]; let edition: String? }; let success: Bool; let data: D? }
        if (response as? HTTPURLResponse) != nil, let h = try? JSONDecoder().decode(Health.self, from: data), h.success, let d = h.data, d.checks["ml"] != nil {
            return .scamShield(edition: d.edition)
        }
        return .otherProgram
    }

    public static let foundationLauncher: EngineLauncher = { layout, environment, log, onExit in
        let p = Process()
        p.executableURL = layout.node
        p.arguments = [layout.serverScript.path]
        p.currentDirectoryURL = layout.workingDirectory
        p.environment = environment
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let handle = try FileHandle(forWritingTo: log)
        handle.seekToEndOfFile()
        p.standardOutput = handle
        p.standardError = handle
        p.standardInput = FileHandle.nullDevice
        p.terminationHandler = { proc in onExit(proc.terminationStatus) }
        try p.run()
        return FoundationEngineProcess(p)
    }
}

final class FoundationEngineProcess: EngineProcess, @unchecked Sendable {
    private let process: Process
    init(_ p: Process) { process = p }
    var isRunning: Bool { process.isRunning }
    func terminate() { process.terminate() }
    func kill() { if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) } }
}

/// Engine environment: everything the on-device engine needs, nothing from a .env file.
public enum EngineEnvironment {
    public static func make(port: Int, authSecret: String, aiKey: String?, home: String = NSHomeDirectory()) -> [String: String] {
        var env: [String: String] = [
            "NODE_ENV": "production",
            "SCAMSHIELD_EDITION": "desktop",
            "SCAMSHIELD_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier),
            "HOSTNAME": "127.0.0.1",
            "PORT": String(port),
            "ML_BACKEND": "embedded",
            "LOCAL_CLIENT_RATE_TIER": "true",
            "ALLOW_BROWSER_EXTENSION": "true",
            "CONTRIBUTIONS_ENABLED": "false",
            "DYNAMIC_INSPECTION_ENABLED": "false",
            "OPENROUTER_REQUIRE_FREE_MODELS": "true",
            "BETTER_AUTH_SECRET": authSecret,
            "BETTER_AUTH_URL": "http://127.0.0.1:\(port)",
            "NEXT_TELEMETRY_DISABLED": "1",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": home,
            "TMPDIR": NSTemporaryDirectory(),
            "LANG": "en_US.UTF-8",
        ]
        if let aiKey, !aiKey.isEmpty {
            env["OPENROUTER_API_KEY"] = aiKey
            env["LLM_ENABLED"] = "true"
        } else {
            env["LLM_ENABLED"] = "false"
        }
        return env
    }

    /// Per-installation random secret for the engine's (unused on desktop) session layer. Not a
    /// user secret; stored 0600 in Application Support.
    public static func authSecret(in dir: URL) -> String {
        let url = dir.appendingPathComponent("engine-secret")
        if let s = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), s.count >= 32 { return s }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let s = bytes.map { String(format: "%02x", $0) }.joined()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? s.write(to: url, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return s
    }
}

/// The optional AI-service key, stored only in the user's login Keychain.
public enum AIKeyStore {
    static let service = "dev.scamshield.mac.ai-key"

    public static func read() -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    @discardableResult
    public static func save(_ key: String) -> Bool {
        delete()
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count < 512 else { return false }
        let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                  kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                  kSecValueData as String: Data(trimmed.utf8)]
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    public static func delete() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }

    public static var isSet: Bool { read() != nil }
}
