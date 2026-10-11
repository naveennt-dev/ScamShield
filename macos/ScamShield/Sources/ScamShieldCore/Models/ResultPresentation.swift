import Foundation

/// What the result screen shows. Derived from an `AnalysisSummary`, so wording rules live in one
/// tested place instead of being scattered through SwiftUI views.
public struct ResultPresentation: Sendable, Equatable {
    public enum Tone: String, Sendable { case safe, caution, danger }

    public var tone: Tone
    public var headline: String
    public var detail: String
    public var riskScore: Int?
    public var categoryLabel: String?
    public var primaryAdvice: String?
    /// Up to three plain-language reasons from the local detection engine ("Why").
    public var reasons: [String]
    /// Up to two recommended actions.
    public var actions: [String]
    public var isSample: Bool
    /// Where the result came from ("Checked on this Mac only." / "+ remote AI" / why remote wasn't used).
    public var source: String?
    /// Limits of this particular check, taken from the service's own warnings (e.g. the ML model
    /// was unavailable, or which of several screen text areas the result is about).
    public var notes: [String]
    /// One sentence: why this colour (from the service's evidence-based decision).
    public var why: String?

    static let maxReasons = 3
    static let maxActions = 2

    public init(summary: AnalysisSummary) {
        isSample = summary.isSample
        source = summary.isSample ? nil : Self.sourceLine(summary.remote)
        // Safe results show the engine's genuine findings too: "no indicators found", or minor signs
        // that were not enough to warn (e.g. "Creates urgency…"), so the user can see WHY it is safe.
        reasons = Array(summary.reasons.prefix(Self.maxReasons))
        notes = Self.notes(from: summary.warnings)
        why = summary.decision?.why
        actions = summary.riskLevel == .safe ? [] : Array(summary.recommendedActions.prefix(Self.maxActions))
        switch summary.riskLevel {
        case .safe:
            tone = .safe
            // "No suspicious content detected" only when the check is genuinely clean. A low score
            // with weak signs (e.g. urgency, a model 50/50) is NOT a clean bill — say so.
            let clean = summary.riskScore < Self.cleanBelow && !Self.hasIndicators(summary.reasons)
            headline = clean ? "No suspicious content detected" : "Low risk — a few weak signs"
            if Self.mlUnavailable(summary.warnings) {
                detail = "Checked with the safety rules only — the ML model was unavailable, so this is a limited check."
            } else {
                detail = clean
                    ? "Nothing concerning was identified."
                    : "Not enough evidence to call this a scam. If it asks for money, an OTP, a PIN or personal details, don't respond."
            }
            riskScore = summary.riskScore
            categoryLabel = nil
            primaryAdvice = nil
        case .suspicious:
            tone = .caution
            headline = "Suspicious Content"
            detail = "Review before interacting."
            riskScore = summary.riskScore
            categoryLabel = Self.label(for: summary).map { "Possible \($0)" }
            primaryAdvice = summary.recommendedActions.first
        case .high, .critical:
            tone = .danger
            headline = "HIGH RISK SCAM"
            detail = summary.riskLevel == .critical ? "Do not interact with this content." : "Be very careful with this content."
            riskScore = summary.riskScore
            categoryLabel = Self.label(for: summary)
            primaryAdvice = summary.recommendedActions.first
        }
    }

    /// Below this score, with no indicators, a safe result is called clean.
    static let cleanBelow = 15

    /// True when the engine reported at least one real indicator (not just "no indicators found").
    static func hasIndicators(_ reasons: [String]) -> Bool {
        reasons.contains { !$0.localizedCaseInsensitiveContains("No known scam indicators") }
    }

    static func mlUnavailable(_ warnings: [String]) -> Bool {
        warnings.contains { $0.localizedCaseInsensitiveContains("ML classifier was unavailable") }
    }

    /// Service warnings worth showing on the card (limits of the check), at most two.
    static func notes(from warnings: [String]) -> [String] {
        let keep = ["ML classifier was unavailable", "Link analysis failed", "separate text areas", "first part of a long input"]
        return Array(warnings.filter { w in keep.contains { w.localizedCaseInsensitiveContains($0) } }.prefix(2))
    }

    static func sourceLine(_ r: RemoteAnalysisInfo?) -> String {
        guard let r, r.requested else { return "Checked on this device only." }
        if r.used { return "Checked on this device + AI second opinion." }
        let why: String
        switch (r.status, r.reason) {
        case ("disabled_on_server", _): why = "it's turned off in the local service"
        case ("not_configured", _): why = "it isn't configured in the local service"
        case ("ignored", _): why = "its answer was set aside by safety checks"
        case (_, "TIMEOUT"?): why = "it timed out"
        case (_, "RATE_LIMITED"?): why = "the AI is busy (rate limited)"
        case (_, "NETWORK"?): why = "no internet connection"
        case (_, "AUTH"?): why = "the API key was rejected"
        case (_, "MODEL_UNAVAILABLE"?): why = "no AI model is available right now"
        default: why = "it was unavailable"
        }
        return "AI second opinion not used (\(why)) — on-device result."
    }

    private static func label(for s: AnalysisSummary) -> String? {
        s.category == "other" || s.categoryLabel.isEmpty ? nil : s.categoryLabel
    }
}
