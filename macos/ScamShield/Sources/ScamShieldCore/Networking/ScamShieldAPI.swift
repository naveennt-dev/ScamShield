import Foundation

/// The scan a request belongs to (set by the coordinator), sent as X-Request-Id so the Mac, API and
/// ML-service logs of one scan can be correlated. An id only — never content.
public enum ScanContext {
    @TaskLocal public static var scanID: UUID?
}

/// The only way the macOS app talks to detection. Implementations talk to the LOCAL ScamShield
/// backend (Next.js, `/api/v1`) — never to OpenRouter or any other third party directly.
public protocol ScamShieldAPI: Sendable {
    func scanMessage(_ text: String) async throws -> AnalysisSummary
    func analyzeURL(_ url: String) async throws -> AnalysisSummary
    func healthCheck() async throws -> BackendHealth
}

public enum ScamShieldAPIError: Error, Equatable, LocalizedError, Sendable {
    case backendUnreachable
    case timedOut
    case rateLimited(retryAfterSeconds: Int?)
    case server(code: String, message: String)
    case invalidResponse
    case emptyInput

    public var errorDescription: String? {
        switch self {
        case .backendUnreachable: return "The local ScamShield service isn't running."
        case .timedOut: return "The local ScamShield service took too long to respond."
        case .rateLimited: return "Too many scans in a short time. Try again in a moment."
        case .server(_, let message): return message
        case .invalidResponse: return "The ScamShield service sent an unexpected response."
        case .emptyInput: return "There was no text to analyse."
        }
    }
}

/// HTTP client for the local backend. Implemented and unit-tested in Phase 1 (health check is used
/// by Settings); scanning endpoints are wired into the scanner in Phase 2+.
public struct LocalScamShieldAPI: ScamShieldAPI {
    public let baseURL: URL
    private let session: URLSession
    private let timeout: TimeInterval
    /// Sent with every scan, so "local" is always explicit. The service never consults a remote
    /// AI unless this says "remote-assisted".
    public let analysisMode: AnalysisMode

    /// `timeout` (35 s) exceeds the service's bounded remote budget (25 s) plus local analysis, so a
    /// slow/unavailable remote AI degrades to the local result instead of a client timeout.
    public init(baseURL: URL, session: URLSession = .shared, timeout: TimeInterval = 35, analysisMode: AnalysisMode = .localOnly) {
        self.baseURL = baseURL
        self.session = session
        self.timeout = timeout
        self.analysisMode = analysisMode
    }

    public func scanMessage(_ text: String) async throws -> AnalysisSummary {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ScamShieldAPIError.emptyInput }
        // The Mac only ever sends OCR text from a screen or region scan: the service analyses it
        // text block by text block (see src/lib/detection/screen.ts).
        return try await send(path: "api/v1/analyze/message", method: "POST", body: ["message": trimmed, "analysisMode": analysisMode.rawValue, "source": "screen"])
    }

    public func analyzeURL(_ url: String) async throws -> AnalysisSummary {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ScamShieldAPIError.emptyInput }
        return try await send(path: "api/v1/analyze/url", method: "POST", body: ["url": trimmed])
    }

    public func healthCheck() async throws -> BackendHealth {
        try await send(path: "api/v1/health", method: "GET", body: nil, acceptStatuses: [200, 503])
    }

    private func send<T: Decodable>(path: String, method: String, body: [String: String]?, acceptStatuses: Set<Int> = [200, 201]) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path), timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("ScamShield-macOS/1", forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false
        if let id = ScanContext.scanID { request.setValue(id.uuidString, forHTTPHeaderField: "X-Request-Id") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .timedOut: throw ScamShieldAPIError.timedOut
            default: throw ScamShieldAPIError.backendUnreachable
            }
        }
        guard let http = response as? HTTPURLResponse else { throw ScamShieldAPIError.invalidResponse }

        let envelope = try? JSONDecoder().decode(APIEnvelope<T>.self, from: data)
        if http.statusCode == 429 {
            throw ScamShieldAPIError.rateLimited(retryAfterSeconds: http.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init))
        }
        if let error = envelope?.error, envelope?.success == false {
            throw ScamShieldAPIError.server(code: error.code, message: error.message)
        }
        guard acceptStatuses.contains(http.statusCode), let envelope, envelope.success, let payload = envelope.data else {
            throw ScamShieldAPIError.invalidResponse
        }
        return payload
    }
}
