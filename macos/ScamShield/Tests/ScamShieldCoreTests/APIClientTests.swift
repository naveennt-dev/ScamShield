import Foundation
import Testing
@testable import ScamShieldCore

/// Intercepts URLSession requests so the HTTP client can be tested without a server.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        Self.lastBody = request.httpBody ?? request.httpBodyStream.map { s in
            s.open(); defer { s.close() }
            var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            return d
        }
        do {
            let (status, headers, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

/// Shape copied from a real `POST /api/v1/analyze/message` response of the Next.js backend
/// (extra fields included to prove unknown keys are ignored).
let realAnalyzeResponse = """
{"success":true,"data":{"id":null,"inputType":"message","classification":"scam","riskLevel":"critical","riskScore":87,"confidence":0.809,
"category":"kyc","categoryLabel":"KYC Scam","reasons":["Asks you to share a one-time password (OTP)."],
"indicators":[{"source":"rules","type":"cred.otp_request","severity":"high","evidence":"…"}],"suspiciousEntities":["sbi-kyc-update.xyz"],
"urls":[],"recommendedActions":["Do not click the link."],"explanation":"This is almost certainly a scam (KYC Scam).","aiSummary":null,
"signals":[],"adjustments":[],"modelMetadata":{"llm":null,"ml":null},"intel":{"knownPattern":false,"reportCount":0},
"warnings":["AI analysis is not configured."],"createdAt":"2026-10-07T17:09:16.138Z"},
"meta":{"requestId":"514ad222","processingTimeMs":36,"version":"v1"}}
"""

@Suite("Local API client", .serialized)
struct APIClientTests {
    let api: LocalScamShieldAPI = {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return LocalScamShieldAPI(baseURL: URL(string: "http://127.0.0.1:3000")!, session: URLSession(configuration: config))
    }()

    @Test func decodesRealAnalyzeResponse() async throws {
        StubProtocol.handler = { _ in (200, ["Content-Type": "application/json"], Data(realAnalyzeResponse.utf8)) }
        let r = try await api.scanMessage("  Dear SBI customer…  ")
        #expect(r.riskLevel == .critical)
        #expect(r.riskScore == 87)
        #expect(r.categoryLabel == "KYC Scam")
        #expect(r.recommendedActions == ["Do not click the link."])
        #expect(!r.isSample)

        let req = try #require(StubProtocol.lastRequest)
        #expect(req.url?.absoluteString == "http://127.0.0.1:3000/api/v1/analyze/message")
        #expect(req.httpMethod == "POST")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(req.value(forHTTPHeaderField: "Authorization") == nil) // no credentials from the app
        let body = try JSONSerialization.jsonObject(with: try #require(StubProtocol.lastBody)) as? [String: String]
        // Phase 4: the mode is always explicit; the default is local-only.
        #expect(body == ["message": "Dear SBI customer…", "analysisMode": "local", "source": "screen"])
        #expect(r.remote == nil) // older/local payload without remoteAnalysis decodes as "local"
    }

    @Test func remoteAssistedModeIsSentOnlyWhenChosen() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let remoteAPI = LocalScamShieldAPI(baseURL: URL(string: "http://127.0.0.1:3000")!, session: URLSession(configuration: config), analysisMode: .remoteAssisted)
        let withRemote = realAnalyzeResponse.replacingOccurrences(
            of: #""intel":{"knownPattern":false,"reportCount":0},"#,
            with: #""intel":{"knownPattern":false,"reportCount":0},"remoteAnalysis":{"requested":true,"used":true,"status":"ok","model":"google/gemma-4-31b-it:free","reason":null,"sentChars":180},"#)
        StubProtocol.handler = { _ in (200, ["Content-Type": "application/json"], Data(withRemote.utf8)) }
        let r = try await remoteAPI.scanMessage("text")
        let body = try JSONSerialization.jsonObject(with: try #require(StubProtocol.lastBody)) as? [String: String]
        #expect(body?["analysisMode"] == "remote-assisted")
        #expect(r.remote == RemoteAnalysisInfo(requested: true, used: true, status: "ok", model: "google/gemma-4-31b-it:free", reason: nil))
        // Still only the local service is contacted — never OpenRouter directly.
        #expect(StubProtocol.lastRequest?.url?.host == "127.0.0.1")
    }

    @Test func analyzeURLHitsURLEndpoint() async throws {
        StubProtocol.handler = { _ in (200, [:], Data(realAnalyzeResponse.utf8)) }
        _ = try await api.analyzeURL("http://sbi-kyc-update.xyz")
        #expect(StubProtocol.lastRequest?.url?.path == "/api/v1/analyze/url")
    }

    @Test func healthIncludingDegraded503() async throws {
        StubProtocol.handler = { _ in (200, [:], Data(#"{"success":true,"data":{"status":"degraded","checks":{"database":"ok","llm":"not_configured"},"appVersion":"1.0.0"},"meta":{}}"#.utf8)) }
        let h = try await api.healthCheck()
        #expect(h.status == "degraded" && h.isReachableAndUsable)
        #expect(h.checks["llm"] == "not_configured")
        StubProtocol.handler = { _ in (503, [:], Data(#"{"success":true,"data":{"status":"down","checks":{"database":"down"}},"meta":{}}"#.utf8)) }
        #expect(try await api.healthCheck().isReachableAndUsable == false)
    }

    @Test func serverErrorsUseBackendMessage() async {
        StubProtocol.handler = { _ in (400, [:], Data(#"{"success":false,"error":{"code":"VALIDATION_ERROR","message":"The request is invalid.","requestId":"r"}}"#.utf8)) }
        await #expect(throws: ScamShieldAPIError.server(code: "VALIDATION_ERROR", message: "The request is invalid.")) { try await api.scanMessage("x") }
    }

    @Test func rateLimit() async {
        StubProtocol.handler = { _ in (429, ["Retry-After": "42"], Data(#"{"success":false,"error":{"code":"RATE_LIMITED","message":"Too many","requestId":"r"}}"#.utf8)) }
        await #expect(throws: ScamShieldAPIError.rateLimited(retryAfterSeconds: 42)) { try await api.scanMessage("x") }
    }

    @Test func garbageAndUnreachable() async {
        StubProtocol.handler = { _ in (200, [:], Data("<html>".utf8)) }
        await #expect(throws: ScamShieldAPIError.invalidResponse) { try await api.scanMessage("x") }
        StubProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        await #expect(throws: ScamShieldAPIError.backendUnreachable) { try await api.healthCheck() }
        StubProtocol.handler = { _ in throw URLError(.timedOut) }
        await #expect(throws: ScamShieldAPIError.timedOut) { try await api.healthCheck() }
    }

    @Test func emptyInputNeverHitsNetwork() async {
        StubProtocol.lastRequest = nil
        await #expect(throws: ScamShieldAPIError.emptyInput) { try await api.scanMessage("   ") }
        #expect(StubProtocol.lastRequest == nil)
    }
}

/// Runs only when SCAMSHIELD_LIVE_API_URL points at a running local backend, e.g.
///   SCAMSHIELD_LIVE_API_URL=http://127.0.0.1:3000 swift test --filter Live
@Suite("Live local backend", .enabled(if: ProcessInfo.processInfo.environment["SCAMSHIELD_LIVE_API_URL"] != nil))
struct LiveBackendTests {
    var api: LocalScamShieldAPI {
        LocalScamShieldAPI(baseURL: try! ConfigurationLoader.validateBaseURL(ProcessInfo.processInfo.environment["SCAMSHIELD_LIVE_API_URL"]!).get())
    }

    @Test func health() async throws {
        #expect(try await api.healthCheck().isReachableAndUsable)
    }

    @Test func analyzesAMessageEndToEnd() async throws {
        let r = try await api.scanMessage("Dear SBI customer, your KYC has expired and your account will be blocked today. Update at http://sbi-kyc-update.xyz/login")
        #expect(r.riskLevel == .high || r.riskLevel == .critical)
        #expect(!r.isSample)
        let ok = try await api.scanMessage("Hey, are we still on for dinner at 8?")
        #expect(ok.riskLevel == .safe)
    }
}
