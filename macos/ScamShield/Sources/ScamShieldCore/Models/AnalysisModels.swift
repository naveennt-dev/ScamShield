import Foundation

/// Mirrors `riskLevel` in the backend's `AnalysisResult` (src/lib/schemas/analysis.ts).
public enum RiskLevel: String, Codable, Sendable, CaseIterable {
    case safe, suspicious, high, critical

    public var isWarning: Bool { self != .safe }
}

public enum Classification: String, Codable, Sendable {
    case safe, suspicious, scam
}

/// The subset of the backend `AnalysisResult` the macOS client needs.
/// Unknown fields are ignored, so the backend can evolve without breaking the app.
public struct AnalysisSummary: Codable, Sendable, Equatable {
    public var id: String?
    public var classification: Classification
    public var riskLevel: RiskLevel
    public var riskScore: Int
    public var confidence: Double
    public var category: String
    public var categoryLabel: String
    public var reasons: [String]
    public var recommendedActions: [String]
    public var explanation: String
    public var warnings: [String]
    /// True only for `MockScamShieldAPI` results (development builds); History refuses to record them.
    public var isSample: Bool
    /// Whether a remote AI was asked / used for this result (nil from older services = local).
    public var remote: RemoteAnalysisInfo?
    /// Why this colour, from the actual evidence (nil from older services).
    public var decision: DecisionExplanation?
    /// The service's completeness verdict (nil from older services = complete).
    public var assessment: AssessmentInfo?
    /// Non-empty when the service could not assess reliably (a detector failed and nothing
    /// suspicious was found). Such a result must never be shown as safe.
    public var assessmentGaps: [String] {
        guard let a = assessment, a.status == "insufficient" else { return [] }
        return a.reasons.isEmpty ? ["part of the check didn't run"] : a.reasons
    }

    public init(
        id: String? = nil,
        classification: Classification,
        riskLevel: RiskLevel,
        riskScore: Int,
        confidence: Double,
        category: String,
        categoryLabel: String,
        reasons: [String] = [],
        recommendedActions: [String] = [],
        explanation: String = "",
        warnings: [String] = [],
        isSample: Bool = false,
        remote: RemoteAnalysisInfo? = nil,
        decision: DecisionExplanation? = nil
    ) {
        self.remote = remote
        self.decision = decision
        self.id = id
        self.classification = classification
        self.riskLevel = riskLevel
        self.riskScore = max(0, min(100, riskScore))
        self.confidence = max(0, min(1, confidence))
        self.category = category
        self.categoryLabel = categoryLabel
        self.reasons = reasons
        self.recommendedActions = recommendedActions
        self.explanation = explanation
        self.warnings = warnings
        self.isSample = isSample
    }

    enum CodingKeys: String, CodingKey {
        case id, classification, riskLevel, riskScore, confidence, category, categoryLabel
        case reasons, recommendedActions, explanation, warnings, isSample
        case remote = "remoteAnalysis"
        case decision
        case assessment
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decodeIfPresent(String.self, forKey: .id),
            classification: try c.decode(Classification.self, forKey: .classification),
            riskLevel: try c.decode(RiskLevel.self, forKey: .riskLevel),
            riskScore: try c.decode(Int.self, forKey: .riskScore),
            confidence: try c.decode(Double.self, forKey: .confidence),
            category: try c.decode(String.self, forKey: .category),
            categoryLabel: try c.decode(String.self, forKey: .categoryLabel),
            reasons: try c.decodeIfPresent([String].self, forKey: .reasons) ?? [],
            recommendedActions: try c.decodeIfPresent([String].self, forKey: .recommendedActions) ?? [],
            explanation: try c.decodeIfPresent(String.self, forKey: .explanation) ?? "",
            warnings: try c.decodeIfPresent([String].self, forKey: .warnings) ?? [],
            isSample: try c.decodeIfPresent(Bool.self, forKey: .isSample) ?? false,
            remote: try? c.decodeIfPresent(RemoteAnalysisInfo.self, forKey: .remote),
            decision: try? c.decodeIfPresent(DecisionExplanation.self, forKey: .decision)
        )
        assessment = try? c.decodeIfPresent(AssessmentInfo.self, forKey: .assessment)
    }
}

/// Whether the service had enough working detectors to call a message safe.
public struct AssessmentInfo: Codable, Sendable, Equatable {
    public var status: String
    public var reasons: [String]
    public init(status: String, reasons: [String]) { self.status = status; self.reasons = reasons }
}

/// Why a result is green / orange / red — built by the service from the actual evidence.
public struct DecisionExplanation: Codable, Sendable, Equatable {
    public struct Match: Codable, Sendable, Equatable {
        public var rule: String
        /// The words in the message that matched (numbers already masked by the service).
        public var text: String
        public var severity: String
        public init(rule: String, text: String, severity: String) { self.rule = rule; self.text = text; self.severity = severity }
    }
    public var colour: String
    public var why: String
    public var basis: [String]
    public var matches: [Match]

    public init(colour: String, why: String, basis: [String], matches: [Match]) {
        self.colour = colour; self.why = why; self.basis = basis; self.matches = matches
    }
}

/// `remoteAnalysis` block of an analysis result (diagnostic codes only, never content).
public struct RemoteAnalysisInfo: Codable, Sendable, Equatable {
    public var requested: Bool
    public var used: Bool
    public var status: String
    public var model: String?
    public var reason: String?

    public init(requested: Bool, used: Bool, status: String, model: String? = nil, reason: String? = nil) {
        self.requested = requested
        self.used = used
        self.status = status
        self.model = model
        self.reason = reason
    }
}

/// `GET /api/v1/health` payload.
public struct BackendHealth: Codable, Sendable, Equatable {
    public var status: String
    public var checks: [String: String]
    public var appVersion: String?

    public init(status: String, checks: [String: String], appVersion: String?) {
        self.status = status
        self.checks = checks
        self.appVersion = appVersion
    }

    public var isReachableAndUsable: Bool { status == "ok" || status == "degraded" }
}

/// Backend response envelope: `{ success, data, meta }` or `{ success: false, error }`.
struct APIEnvelope<T: Decodable>: Decodable {
    let success: Bool
    let data: T?
    let error: APIErrorBody?
}

struct APIErrorBody: Decodable, Sendable {
    let code: String
    let message: String
    let requestId: String?
}
