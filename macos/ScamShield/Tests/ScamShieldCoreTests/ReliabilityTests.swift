import Foundation
import Testing
@testable import ScamShieldCore
import ScamShieldDevSupport

/// Phase 6 — lifecycle reliability: permission changes, repeated failures, capacity.

/// Fails the first `failures` calls with `error`, then answers with a sample result.
actor FlakyAPI: ScamShieldAPI {
    private(set) var calls = 0
    let failures: Int
    let error: ScamShieldAPIError
    init(failures: Int, error: ScamShieldAPIError = .backendUnreachable) { self.failures = failures; self.error = error }
    func scanMessage(_ text: String) async throws -> AnalysisSummary {
        calls += 1
        if calls <= failures { throw error }
        var s = try MockScamShieldAPI.sample(for: .critical)
        s.isSample = false
        return s
    }
    func analyzeURL(_ url: String) async throws -> AnalysisSummary { throw error }
    func healthCheck() async throws -> BackendHealth { BackendHealth(status: "ok", checks: ["llm": "disabled"], appVersion: nil) }
}

@MainActor
@Suite("Phase 6 — reliability")
struct ReliabilityTests {
    func coordinator() -> ScannerCoordinator { ScannerCoordinator(minimumStageDuration: .zero, textReadyHold: .zero, sleep: { _ in }) }
    func deps(_ p: FakePermission, api: any ScamShieldAPI = FlakyAPI(failures: 0)) -> ScannerDependencies {
        ScannerDependencies(permission: p, targets: FakeTargets(region: nil), capturer: CaptureSpy(),
                            recognizer: FakeOCR(text: "Your KYC expired. Share OTP at sbi-kyc-update.xyz"), api: api, analysisGate: nil)
    }

    @Test func deniedThenRegrantedPermissionResumesScanning() async {
        let c = coordinator(), p = FakePermission(.denied), cap = CaptureSpy()
        var d = deps(p); d.capturer = cap
        c.start(.fullScreen, with: d); await c.waitUntilFinished()
        #expect(c.phase == .failed(.permissionDenied))
        #expect(await cap.targets.isEmpty) // nothing captured without permission
        c.dismiss()
        p.current = .granted // user turned it on in System Settings
        c.start(.fullScreen, with: d); await c.waitUntilFinished()
        #expect(c.phase.isResult)
        #expect(await cap.targets.count == 1)
    }

    @Test func revokedPermissionIsCheckedOnEveryScan() async {
        let c = coordinator(), p = FakePermission(.granted)
        c.start(.fullScreen, with: deps(p)); await c.waitUntilFinished()
        #expect(c.phase.isResult)
        c.dismiss()
        p.current = .denied
        c.start(.fullScreen, with: deps(p)); await c.waitUntilFinished()
        #expect(c.phase == .failed(.permissionDenied))
    }

    @Test func recoversAfterManyFailedScansWithoutRetryStorms() async {
        let c = coordinator(), api = FlakyAPI(failures: 20)
        let d = deps(FakePermission(.granted), api: api)
        for _ in 0..<20 {
            #expect(c.start(.fullScreen, with: d))
            await c.waitUntilFinished()
            #expect(c.phase == .failed(.analysisServiceUnavailable)) // clear error, never a fabricated result
            c.dismiss()
        }
        #expect(await api.calls == 20) // exactly one request per user-started scan (no hidden retries)
        c.start(.fullScreen, with: d); await c.waitUntilFinished()
        #expect(c.phase.isResult)
        #expect(await api.calls == 21)
    }

    @Test func timeoutsAndRateLimitsAreClearErrors() async {
        for (err, expected) in [(ScamShieldAPIError.timedOut, "too long"), (.rateLimited(retryAfterSeconds: 30), "Too many")] {
            let c = coordinator()
            c.start(.fullScreen, with: deps(FakePermission(.granted), api: FlakyAPI(failures: 1, error: err)))
            await c.waitUntilFinished()
            guard case .failed(let f) = c.phase else { Issue.record("expected failure for \(err)"); continue }
            #expect(f.message.localizedCaseInsensitiveContains(expected), "\(f)")
            #expect(f != .analysisServiceUnavailable) // a slow or busy service is not "not running"
        }
    }

    @Test func historyAtCapacityStaysFastAndBounded() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ss-cap-\(UUID().uuidString)")
        let n = "ss.cap.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: n)!
        defer { d.removePersistentDomain(forName: n); try? FileManager.default.removeItem(at: dir) }
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let s = HistoryStore(directory: dir, defaults: d, now: { clock })
        var summary = try MockScamShieldAPI.sample(for: .critical)
        summary.isSample = false
        for i in 0..<HistoryStore.maxEntries { clock += 300; s.record(scanID: UUID(), summary: summary, text: "msg \(i) https://x\(i).example/p", mode: .localOnly) }
        let t0 = ContinuousClock.now
        clock += 300
        s.record(scanID: UUID(), summary: summary, text: "one more", mode: .localOnly)
        let ms = (ContinuousClock.now - t0).components.attoseconds / 1_000_000_000_000_000
        let bytes = (try FileManager.default.attributesOfItem(atPath: s.fileURL.path)[.size] as? NSNumber)?.intValue ?? 0
        print("PERF history at capacity: \(s.entries.count) entries, record+save \(ms) ms, file \(bytes / 1024) KB")
        #expect(s.entries.count == HistoryStore.maxEntries)
        #expect(ms < 250)
        #expect(bytes < 1_000_000)
        let t1 = ContinuousClock.now
        let reloaded = HistoryStore(directory: dir, defaults: d, now: { clock })
        print("PERF history load at capacity: \((ContinuousClock.now - t1).components.attoseconds / 1_000_000_000_000_000) ms")
        #expect(reloaded.entries.count == HistoryStore.maxEntries)
    }
}
