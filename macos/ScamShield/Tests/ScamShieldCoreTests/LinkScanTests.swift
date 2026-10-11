import Foundation
import Testing
@testable import ScamShieldCore

/// Own stub (the API client suite's stub is static and shared).
final class LinkStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest, Data?) -> (Int, Data, TimeInterval))?
    nonisolated(unsafe) static var lastBody: [String: Any]?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody
        if body == nil, let s = request.httpBodyStream {
            s.open(); var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            s.close(); body = d
        }
        Self.lastBody = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let (status, data, delay) = Self.handler!(request, body)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.client?.urlProtocol(self, didReceive: HTTPURLResponse(url: self.request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

/// A real response produced by the TypeScript link scanner (tests/… fixture; fake-YouTube page).
let realLinkReport: Data = {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/link-report.json")
    return (try? Data(contentsOf: url)) ?? Data()
}()

@MainActor
@Suite("Scan Link", .serialized)
struct LinkScanTests {
    func client(_ mode: AnalysisMode = .remoteAssisted) -> LinkScanClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LinkStub.self]
        return LinkScanClient(baseURL: URL(string: "http://127.0.0.1:3000")!, analysisMode: mode, session: URLSession(configuration: config))
    }

    @Test func decodesARealReportAndSendsTheMode() async throws {
        LinkStub.handler = { _, _ in (200, realLinkReport, 0) }
        let r = try await client(.localOnly).scan("youtube-watch-premium.top/v", inspectBehaviour: false)
        #expect(r.verdict == "high_risk" && r.riskLevel == .high)
        #expect(r.page.kind == "youtube_imitation")
        #expect(!r.evidence.isEmpty && !r.coverage.isEmpty && r.categories.count == 5)
        #expect(LinkStub.lastBody?["analysisMode"] as? String == "local")
        #expect(LinkStub.lastBody?["inspectBehaviour"] as? Bool == false)
        _ = try await client(.remoteAssisted).scan("x.com", inspectBehaviour: true)
        #expect(LinkStub.lastBody?["analysisMode"] as? String == "remote-assisted")
        #expect(LinkStub.lastBody?["inspectBehaviour"] as? Bool == true)
    }

    @Test func inconclusiveIsNeverSafe() throws {
        var r = try JSONDecoder().decode(APIEnvelope<LinkReport>.self, from: realLinkReport).data!
        for (v, level) in [("malicious", RiskLevel.critical), ("high_risk", .high), ("suspicious", .suspicious), ("no_known_threat", .safe)] {
            r.verdict = v
            #expect(r.riskLevel == level)
        }
        r.verdict = "inconclusive"
        #expect(r.riskLevel == nil)
    }

    @Test func historyKeepsOnlyTheRedactedAddressAndInconclusiveIsNotAssessed() throws {
        let name = "scamshield.tests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        defer { d.removePersistentDomain(forName: name) }
        let h = HistoryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), defaults: d)
        var r = try JSONDecoder().decode(APIEnvelope<LinkReport>.self, from: realLinkReport).data!
        r.url = "https://youtube-watch-premium.top/v?session=…"
        let e = try #require(h.recordLink(r, mode: .remoteAssisted))
        #expect(e.captureMode == .link && e.riskLevel == .high)
        #expect(e.text == "https://youtube-watch-premium.top/…")
        #expect(e.linkHosts == ["youtube-watch-premium.top"])
        r.verdict = "inconclusive"
        let f = try #require(h.recordLink(r, mode: .remoteAssisted))
        #expect(f.riskLevel == nil && !f.completed && f.headline == "Unable to assess")
    }

    @Test func cancelNeverShowsSafe() async throws {
        LinkStub.handler = { _, _ in (200, realLinkReport, 3) }
        let m = LinkScanModel(client: { self.client() })
        m.input = "https://example.com"
        m.start(inspectBehaviour: true)
        #expect(m.isBusy)
        try await Task.sleep(for: .milliseconds(200))
        m.cancel()
        #expect(m.phase == .failed("Cancelled — nothing was marked safe."))
    }

    @Test func serviceErrorsAreShownNotHidden() async throws {
        LinkStub.handler = { _, _ in (429, Data("{}".utf8), 0) }
        let m = LinkScanModel(client: { self.client() })
        m.input = "https://example.com"
        m.start(inspectBehaviour: false)
        for _ in 0..<50 where m.isBusy { try await Task.sleep(for: .milliseconds(20)) }
        guard case .failed(let msg) = m.phase else { Issue.record("expected failure, got \(m.phase)"); return }
        #expect(msg.localizedCaseInsensitiveContains("too many") || msg.localizedCaseInsensitiveContains("wait"))
    }
}
