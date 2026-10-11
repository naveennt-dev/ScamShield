import Foundation

public protocol AnalysisGate: Sendable {
    /// Throws a `ScannerFailure` if text must not be sent.
    func verify() async throws
}

/// Before sending OCR text, confirm via `GET /api/v1/health` that the local service will honour
/// the user's analysis mode. In local-only mode (the default) the service's remote AI must be off
/// ("disabled" / "not_configured") or opt-in only ("opt_in": used solely for requests that say
/// "remote-assisted", which this app never sends in local-only mode). A service reporting "ok" —
/// a pre-Phase-4 backend that may consult the AI without being asked — is refused: nothing is sent.
/// The result is cached briefly to avoid a health call per scan.
public actor LocalOnlyGuard: AnalysisGate {
    private let api: any ScamShieldAPI
    private let cacheFor: Duration
    private let mode: AnalysisMode
    private var lastOK: ContinuousClock.Instant?

    public init(api: any ScamShieldAPI, mode: AnalysisMode = .localOnly, cacheFor: Duration = .seconds(30)) {
        self.api = api
        self.mode = mode
        self.cacheFor = cacheFor
    }

    public static let allowedLLMStates: Set<String> = ["disabled", "not_configured", "opt_in"]

    public func verify() async throws {
        if let lastOK, ContinuousClock.now - lastOK < cacheFor { return }
        let health: BackendHealth
        do {
            health = try await api.healthCheck()
        } catch {
            throw ScannerFailure.analysisServiceUnavailable
        }
        guard health.isReachableAndUsable else { throw ScannerFailure.analysisServiceUnavailable }
        // Remote-assisted: the user consented; any service state is acceptable (if remote analysis
        // isn't available there, the result says so and is local).
        if mode == .localOnly {
            guard let llm = health.checks["llm"], Self.allowedLLMStates.contains(llm) else {
                throw ScannerFailure.cloudAnalysisEnabled
            }
        }
        lastOK = ContinuousClock.now
    }
}
