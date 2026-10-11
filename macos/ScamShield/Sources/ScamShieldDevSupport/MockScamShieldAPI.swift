import Foundation
import ScamShieldCore

/// Deterministic sample responses for UI previews and tests. Results are flagged `isSample` and
/// the UI labels them as previews — they are never presented as real detection.
public struct MockScamShieldAPI: ScamShieldAPI {
    public enum Scenario: String, Sendable, CaseIterable {
        case safe, suspicious, critical, failure
    }

    public var scenario: Scenario
    public var latency: Duration

    public init(scenario: Scenario, latency: Duration = .zero) {
        self.scenario = scenario
        self.latency = latency
    }

    public func scanMessage(_ text: String) async throws -> AnalysisSummary {
        try await Task.sleep(for: latency)
        return try Self.sample(for: scenario)
    }

    public func analyzeURL(_ url: String) async throws -> AnalysisSummary {
        try await Task.sleep(for: latency)
        return try Self.sample(for: scenario)
    }

    public func healthCheck() async throws -> BackendHealth {
        BackendHealth(status: "ok", checks: ["mock": "ok"], appVersion: "mock")
    }

    public static func sample(for scenario: Scenario) throws -> AnalysisSummary {
        switch scenario {
        case .safe:
            return AnalysisSummary(
                classification: .safe, riskLevel: .safe, riskScore: 4, confidence: 0.86,
                category: "other", categoryLabel: "Other",
                reasons: ["No known scam indicators were found."], isSample: true)
        case .suspicious:
            return AnalysisSummary(
                classification: .suspicious, riskLevel: .suspicious, riskScore: 78, confidence: 0.71,
                category: "phishing", categoryLabel: "Phishing",
                reasons: ["Urgent action requested.", "External link detected.", "Account-related pressure."],
                recommendedActions: ["Review before interacting."], isSample: true)
        case .critical:
            return AnalysisSummary(
                classification: .scam, riskLevel: .critical, riskScore: 94, confidence: 0.9,
                category: "kyc", categoryLabel: "Banking / KYC Scam",
                reasons: ["Urgent verification request.", "Suspicious external link.", "Account suspension threat."],
                recommendedActions: ["Do not click the link.", "Do not share OTP, PIN or CVV."], isSample: true)
        case .failure:
            throw ScamShieldAPIError.backendUnreachable
        }
    }
}
