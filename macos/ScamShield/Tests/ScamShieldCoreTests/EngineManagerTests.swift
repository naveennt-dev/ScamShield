import Foundation
import Testing
@testable import ScamShieldCore

/// Fake engine process.
final class FakeEngine: EngineProcess, @unchecked Sendable {
    var isRunning = true
    var terminated = false
    var killed = false
    var exit: (@Sendable (Int32) -> Void)?
    func terminate() { terminated = true; isRunning = false }
    func kill() { killed = true; isRunning = false }
    func crash() { isRunning = false; exit?(1) }
}

/// Probe whose answer can change over time.
final class ProbeScript: @unchecked Sendable {
    var answers: [EngineProbe]
    var calls = 0
    init(_ a: [EngineProbe]) { answers = a }
    func next() -> EngineProbe { calls += 1; return answers.count > 1 ? answers.removeFirst() : answers[0] }
}

@MainActor
@Suite("Engine manager", .serialized)
struct EngineManagerTests {
    let layout = EngineLayout(node: URL(fileURLWithPath: "/tmp/node"), serverScript: URL(fileURLWithPath: "/tmp/server.js"), workingDirectory: URL(fileURLWithPath: "/tmp"))
    let log = FileManager.default.temporaryDirectory.appendingPathComponent("engine-test-\(UUID().uuidString).log")

    func manager(_ probe: ProbeScript, layout: EngineLayout?, launches: Box<[FakeEngine]>, timeout: Duration = .seconds(2)) -> EngineManager {
        EngineManager(
            baseURL: URL(string: "http://127.0.0.1:3000")!, layout: layout, logURL: log,
            probe: { _ in probe.next() },
            launcher: { _, _, _, onExit in
                let e = FakeEngine()
                e.exit = onExit
                launches.value.append(e)
                return e
            },
            environment: { EngineEnvironment.make(port: 3000, authSecret: String(repeating: "a", count: 64), aiKey: nil) },
            startupTimeout: timeout, pollInterval: .milliseconds(10))
    }

    @Test func reusesAServiceThatIsAlreadyRunning() async {
        let launches = Box<[FakeEngine]>([])
        let m = manager(ProbeScript([.scamShield(edition: "server")]), layout: layout, launches: launches)
        await m.start()
        #expect(m.state == .running(managed: false))
        #expect(launches.value.isEmpty)
    }

    @Test func refusesAPortTakenByAnotherProgram() async {
        let launches = Box<[FakeEngine]>([])
        let m = manager(ProbeScript([.otherProgram]), layout: layout, launches: launches)
        await m.start()
        guard case .failed(let why) = m.state else { Issue.record("\(m.state)"); return }
        #expect(why.contains("Another program"))
        #expect(launches.value.isEmpty)
    }

    @Test func missingEngineIsReportedNotHidden() async {
        let m = manager(ProbeScript([.nothing]), layout: nil, launches: Box([]))
        await m.start()
        guard case .failed(let why) = m.state else { Issue.record("\(m.state)"); return }
        #expect(why.contains("missing"))
    }

    @Test func startsTheBundledEngineAndWaitsUntilHealthy() async {
        let launches = Box<[FakeEngine]>([])
        let m = manager(ProbeScript([.nothing, .nothing, .nothing, .scamShield(edition: "desktop")]), layout: layout, launches: launches)
        await m.start()
        #expect(m.state == .running(managed: true))
        #expect(launches.value.count == 1)
    }

    @Test func startupTimeoutKillsTheProcessAndFails() async {
        let launches = Box<[FakeEngine]>([])
        let m = manager(ProbeScript([.nothing]), layout: layout, launches: launches, timeout: .milliseconds(150))
        await m.start()
        guard case .failed = m.state else { Issue.record("\(m.state)"); return }
        #expect(launches.value.first?.killed == true)
    }

    @Test func restartsAfterACrashButGivesUpAfterThree() async throws {
        let launches = Box<[FakeEngine]>([])
        let probe = ProbeScript([.nothing, .scamShield(edition: "desktop")])
        let m = manager(probe, layout: layout, launches: launches)
        await m.start()
        for i in 1...4 {
            probe.answers = [.nothing, .scamShield(edition: "desktop")]
            launches.value.last?.crash()
            for _ in 0..<100 where launches.value.count == i { try await Task.sleep(for: .milliseconds(10)) }
            for _ in 0..<100 where m.state == .starting { try await Task.sleep(for: .milliseconds(10)) }
        }
        guard case .failed(let why) = m.state else { Issue.record("expected give-up, got \(m.state)"); return }
        #expect(why.contains("keeps stopping"))
        #expect(launches.value.count == 4) // first start + 3 restarts
    }

    @Test func stopTerminatesAndDoesNotRestart() async throws {
        let launches = Box<[FakeEngine]>([])
        let m = manager(ProbeScript([.nothing, .scamShield(edition: "desktop")]), layout: layout, launches: launches)
        await m.start()
        m.stop()
        #expect(launches.value[0].terminated)
        launches.value[0].exit?(0)
        try await Task.sleep(for: .milliseconds(50))
        #expect(m.state == .idle)
        #expect(launches.value.count == 1)
    }

    @Test func environmentIsMinimalAndLocal() {
        let env = EngineEnvironment.make(port: 3000, authSecret: "s", aiKey: nil)
        #expect(env["HOSTNAME"] == "127.0.0.1" && env["SCAMSHIELD_EDITION"] == "desktop")
        #expect(env["LLM_ENABLED"] == "false" && env["OPENROUTER_API_KEY"] == nil)
        #expect(env["DATABASE_URL"] == nil && env["REDIS_URL"] == nil)
        #expect(env["DYNAMIC_INSPECTION_ENABLED"] == "false" && env["CONTRIBUTIONS_ENABLED"] == "false")
        #expect(env["OPENROUTER_REQUIRE_FREE_MODELS"] == "true")
        let withKey = EngineEnvironment.make(port: 3000, authSecret: "s", aiKey: "k-123")
        #expect(withKey["LLM_ENABLED"] == "true" && withKey["OPENROUTER_API_KEY"] == "k-123")
    }

    @Test func authSecretIsStablePrivateAndRandom() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("eng-\(UUID().uuidString)")
        let a = EngineEnvironment.authSecret(in: dir)
        #expect(a.count == 64 && a == EngineEnvironment.authSecret(in: dir))
        let attrs = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent("engine-secret").path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #expect(a != EngineEnvironment.authSecret(in: FileManager.default.temporaryDirectory.appendingPathComponent("eng-\(UUID().uuidString)")))
    }
}

final class Box<T>: @unchecked Sendable { var value: T; init(_ v: T) { value = v } }
