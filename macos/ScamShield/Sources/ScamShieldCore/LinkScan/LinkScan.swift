import Foundation
import Observation

/// Link scan report from the local service (POST /api/v1/analyze/link). Display subset.
public struct LinkReport: Decodable, Sendable, Equatable {
    public struct Hop: Decodable, Sendable, Equatable { public var url: String; public var status: Int? }
    public struct YouTube: Decodable, Sendable, Equatable { public var videoId: String?; public var embeddedPlayers: Int; public var note: String? }
    public struct Page: Decodable, Sendable, Equatable { public var kind: String; public var title: String?; public var youtube: YouTube }
    public struct Download: Decodable, Sendable, Equatable { public var fileName: String?; public var detectedKind: String; public var mismatch: String?; public var sha256: String? }
    public struct Category: Decodable, Sendable, Equatable { public var category: String; public var label: String; public var status: String; public var evidence: [String] }
    public struct Evidence: Decodable, Sendable, Equatable { public var id: String; public var category: String; public var kind: String; public var severity: String; public var detail: String }
    public struct Coverage: Decodable, Sendable, Equatable { public var id: String; public var label: String; public var status: String; public var detail: String? }
    public struct Dynamic: Decodable, Sendable, Equatable {
        public struct Requests: Decodable, Sendable, Equatable { public var total: Int; public var thirdPartyHosts: [String] }
        public var status: String
        public var detail: String?
        public var observedWindowMs: Double
        public var typedDataSentTo: [String]
        public var downloadsAttempted: [String]
        public var permissionRequests: [String]
        public var requests: Requests
    }

    public var ok: Bool
    public var url: String?
    public var hostname: String?
    public var displayHostname: String?
    public var finalUrl: String?
    public var redirectChain: [Hop]
    public var page: Page
    public var download: Download?
    public var verdict: String
    public var verdictLabel: String
    public var summary: String
    public var recommendedAction: String
    public var categories: [Category]
    public var evidence: [Evidence]
    public var coverage: [Coverage]
    public var limitations: [String]
    public var disclosures: [String]
    public var dynamic: Dynamic?

    /// Verdict mapped onto the app's risk levels (nil = not assessed → never shown as safe).
    public var riskLevel: RiskLevel? {
        switch verdict {
        case "malicious": return .critical
        case "high_risk": return .high
        case "suspicious": return .suspicious
        case "no_known_threat": return .safe
        default: return nil
        }
    }
}

/// Talks to the local service's link scanner. Separate from `ScamShieldAPI` (screen scans).
public struct LinkScanClient: Sendable {
    public let baseURL: URL
    public let analysisMode: AnalysisMode
    let session: URLSession

    public init(baseURL: URL, analysisMode: AnalysisMode, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.analysisMode = analysisMode
        self.session = session
    }

    public func scan(_ url: String, inspectBehaviour: Bool) async throws -> LinkReport {
        var request = URLRequest(url: baseURL.appending(path: "api/v1/analyze/link"), timeoutInterval: inspectBehaviour ? 90 : 45)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ScamShield-macOS/1", forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "url": url,
            "analysisMode": analysisMode.rawValue == "local" ? "local" : "remote-assisted",
            "inspectBehaviour": inspectBehaviour,
        ])
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch let e as URLError {
            throw e.code == .timedOut ? ScamShieldAPIError.timedOut : ScamShieldAPIError.backendUnreachable
        }
        let env = try? JSONDecoder().decode(APIEnvelope<LinkReport>.self, from: data)
        if (response as? HTTPURLResponse)?.statusCode == 429 { throw ScamShieldAPIError.rateLimited(retryAfterSeconds: nil) }
        if let e = env?.error { throw ScamShieldAPIError.server(code: e.code, message: e.message) }
        guard let report = env?.data else { throw ScamShieldAPIError.invalidResponse }
        return report
    }
}

/// State of the "Scan Link" window.
@MainActor
@Observable
public final class LinkScanModel {
    public enum Phase: Equatable {
        case idle
        case scanning(inspect: Bool)
        case done(LinkReport)
        case failed(String)
    }

    public var input = ""
    public private(set) var phase: Phase = .idle
    public private(set) var stage = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let client: () -> LinkScanClient
    @ObservationIgnored private let onReport: (LinkReport) -> Void

    public static let stages = ["Checking the address…", "Following redirects safely…", "Reading the page without running it…", "Checking threat lists and the AI second opinion…"]
    public static let inspectStages = ["Starting a disposable isolated browser…", "Loading the page with test data only…", "Watching what the page does…", "Closing and deleting the isolated browser…"]

    public init(client: @escaping () -> LinkScanClient, onReport: @escaping (LinkReport) -> Void = { _ in }) {
        self.client = client
        self.onReport = onReport
    }

    public var isBusy: Bool { if case .scanning = phase { return true } else { return false } }

    public func start(inspectBehaviour: Bool) {
        let url = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty, !isBusy else { return }
        task?.cancel()
        phase = .scanning(inspect: inspectBehaviour)
        stage = 0
        let c = client()
        task = Task { [weak self] in
            let ticker = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(inspectBehaviour ? 5 : 2))
                    await MainActor.run { if let s = self, s.stage < 3 { s.stage += 1 } }
                }
            }
            defer { ticker.cancel() }
            do {
                let r = try await c.scan(url, inspectBehaviour: inspectBehaviour)
                guard !Task.isCancelled else { return }
                self?.phase = .done(r)
                self?.onReport(r)
            } catch is CancellationError {
                self?.phase = .failed("Cancelled — nothing was marked safe.")
            } catch let e as ScamShieldAPIError {
                self?.phase = .failed(e.errorDescription ?? "The link couldn't be checked.")
            } catch {
                self?.phase = .failed("The link couldn't be checked.")
            }
        }
    }

    public func cancel() {
        task?.cancel()
        if isBusy { phase = .failed("Cancelled — nothing was marked safe.") }
    }
}
