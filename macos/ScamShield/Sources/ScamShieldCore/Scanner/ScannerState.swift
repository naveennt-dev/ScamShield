import Foundation

public enum CaptureMode: String, Sendable, Equatable, Codable {
    case fullScreen
    case region
    /// A link checked with "Scan Link" (no screen capture).
    case link
}

/// Terminal problems. Each maps to its own screen with friendly copy — never raw errors.
public enum ScannerFailure: Error, Equatable, Sendable {
    /// First request: the system prompt was shown; the user must allow ScamShield.
    case permissionRequired
    /// Denied or revoked earlier.
    case permissionDenied
    case captureFailed
    case ocrFailed
    case noTextDetected
    case analysisServiceUnavailable
    /// The local service has cloud AI enabled; Phase 2 is local-only, so nothing was sent.
    case cloudAnalysisEnabled
    case analysisFailed(String)
    /// Nothing suspicious was found, but a detector failed (e.g. the ML model was unavailable and
    /// no AI second opinion was available): never shown as a safe result.
    case unableToAssess([String])

    public var title: String {
        switch self {
        case .permissionRequired: return "Screen Recording Permission Required"
        case .permissionDenied: return "Screen access unavailable"
        case .captureFailed: return "Couldn't capture the selected area."
        case .ocrFailed: return "Couldn't read this content"
        case .noTextDetected: return "No readable text detected"
        case .analysisServiceUnavailable: return "ScamShield analysis service isn't running."
        case .cloudAnalysisEnabled: return "Cloud AI is enabled in the local service"
        case .analysisFailed: return "Couldn't analyse the text"
        case .unableToAssess: return "Unable to assess"
        }
    }

    public var message: String {
        switch self {
        case .permissionRequired:
            return "ScamShield needs permission to inspect the screen when you explicitly start a scan.\nScamShield does not continuously monitor your screen."
        case .permissionDenied:
            return "Enable Screen Recording permission for ScamShield in System Settings."
        case .captureFailed:
            return "Try again."
        case .ocrFailed:
            return "Try again with a clearer message."
        case .noTextDetected:
            return "Try selecting the message more precisely."
        case .analysisServiceUnavailable:
            return "Start the local ScamShield service and try again."
        case .cloudAnalysisEnabled:
            return "ScamShield is in local-only mode, but this service could use cloud AI without being asked (it's older than the app). Nothing was sent. Restart it with scripts/scamshield.sh restart."
        case .analysisFailed(let reason):
            return reason
        case .unableToAssess(let gaps):
            let why = gaps.isEmpty ? "part of the check didn't run" : gaps.joined(separator: " and ")
            return "No warning signs were found, but \(why) — so this is not a safe verdict. Check the message yourself, or try again in a moment."
        }
    }

    /// Permission problems offer an "Open System Settings" button.
    public var opensSystemSettings: Bool {
        self == .permissionRequired || self == .permissionDenied
    }

    public var canRetry: Bool {
        switch self {
        case .permissionRequired, .permissionDenied, .cloudAnalysisEnabled: return false
        default: return true
        }
    }
}

/// Counts and (developer-only) preview of the extracted text. The full text is never logged.
public struct ExtractedTextSummary: Sendable, Equatable {
    public let lineCount: Int
    public let characterCount: Int
    public let urlCount: Int
    public let confidence: Double
    public let wasTruncated: Bool
    /// Shown only in Debug mode.
    public let preview: String

    public init(lineCount: Int, characterCount: Int, urlCount: Int, confidence: Double, wasTruncated: Bool, preview: String) {
        self.lineCount = lineCount
        self.characterCount = characterCount
        self.urlCount = urlCount
        self.confidence = confidence
        self.wasTruncated = wasTruncated
        self.preview = preview
    }
}

/// Scanner states:
///
///   idle → requestingPermission → [selectingRegion] → capturing → processingOCR → textReady
///        → sendingForAnalysis → safe | suspicious → idle
///   any working state → cancelled | failed(permissionRequired | permissionDenied | captureFailed |
///                                          ocrFailed | noTextDetected | analysisServiceUnavailable |
///                                          cloudAnalysisEnabled | analysisFailed)
public enum ScannerPhase: Equatable, Sendable {
    case idle
    case requestingPermission(CaptureMode)
    case selectingRegion
    case capturing(CaptureMode)
    case processingOCR
    case textReady(ExtractedTextSummary)
    case sendingForAnalysis
    case safe(ResultPresentation)
    case suspicious(ResultPresentation)
    case cancelled
    case failed(ScannerFailure)

    public var isBusy: Bool {
        switch self {
        case .requestingPermission, .selectingRegion, .capturing, .processingOCR, .textReady, .sendingForAnalysis: return true
        default: return false
        }
    }

    public var isResult: Bool {
        switch self {
        case .safe, .suspicious, .failed, .cancelled: return true
        default: return false
        }
    }

    /// Progress stage for the UI (stage-based; no invented percentages).
    public var stage: ScanStage? {
        switch self {
        case .requestingPermission, .capturing: return .capturing
        case .processingOCR: return .readingText
        case .textReady: return .preparingAnalysis
        case .sendingForAnalysis: return .analyzing
        default: return nil
        }
    }
}

public enum ScanStage: Int, Sendable, CaseIterable, Comparable {
    case capturing, readingText, preparingAnalysis, analyzing

    public static func < (a: ScanStage, b: ScanStage) -> Bool { a.rawValue < b.rawValue }

    public var label: String {
        switch self {
        case .capturing: return "Capturing screen"
        case .readingText: return "Reading text"
        case .preparingAnalysis: return "Preparing analysis"
        case .analyzing: return "Analyzing"
        }
    }
}

public enum ScannerEvent: Equatable, Sendable {
    case start(CaptureMode)
    case permissionGranted
    case regionSelected
    case captured
    case textRecognized(ExtractedTextSummary)
    case submitted
    case analyzed(AnalysisSummary)
    case cancel
    case failed(ScannerFailure)
    case dismiss
}

/// Pure transition function; returns nil for transitions that are not allowed.
public enum ScannerMachine {
    public static func reduce(_ phase: ScannerPhase, _ event: ScannerEvent) -> ScannerPhase? {
        switch (phase, event) {
        case (_, .dismiss):
            return .idle
        case (.idle, .start(let m)), (.safe, .start(let m)), (.suspicious, .start(let m)), (.failed, .start(let m)), (.cancelled, .start(let m)):
            return .requestingPermission(m)
        case (.requestingPermission(.region), .permissionGranted):
            return .selectingRegion
        case (.requestingPermission(.fullScreen), .permissionGranted):
            return .capturing(.fullScreen)
        case (.selectingRegion, .regionSelected):
            return .capturing(.region)
        case (.capturing, .captured):
            return .processingOCR
        case (.processingOCR, .textRecognized(let summary)):
            return .textReady(summary)
        case (.textReady, .submitted):
            return .sendingForAnalysis
        case (.sendingForAnalysis, .analyzed(let s)):
            let p = ResultPresentation(summary: s)
            return s.riskLevel.isWarning ? .suspicious(p) : .safe(p)
        case (let p, .cancel) where p.isBusy:
            return .cancelled
        case (let p, .failed(let f)) where p.isBusy:
            return .failed(f)
        default:
            return nil
        }
    }
}
