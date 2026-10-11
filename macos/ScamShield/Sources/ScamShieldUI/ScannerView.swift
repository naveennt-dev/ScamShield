import SwiftUI
import ScamShieldCore

/// The scanner card shown in the floating panel. Pure function of `ScannerPhase`.
public struct ScannerView: View {
    public let phase: ScannerPhase
    /// True while Vision prepares its model for the first time (first scan after install/update).
    public var ocrPreparing: Bool
    public var onClose: () -> Void
    public var onScanAgain: () -> Void
    public var onOpenSettings: () -> Void
    /// Opens this result in History (where it can be reported). nil hides the link.
    public var onShowHistory: (() -> Void)?

    public init(
        phase: ScannerPhase,
        ocrPreparing: Bool = false,
        onClose: @escaping () -> Void = {},
        onScanAgain: @escaping () -> Void = {},
        onOpenSettings: @escaping () -> Void = {},
        onShowHistory: (() -> Void)? = nil
    ) {
        self.onShowHistory = onShowHistory
        self.phase = phase
        self.ocrPreparing = ocrPreparing
        self.onClose = onClose
        self.onScanAgain = onScanAgain
        self.onOpenSettings = onOpenSettings
    }

    public static let size = CGSize(width: 420, height: 580)
    /// Height of the draggable strip along the top edge (the card's 32 pt padding + a margin).
    public static let dragHeaderHeight: CGFloat = 44

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                switch phase {
                case .idle:
                    StatusStack(title: "ScamShield", subtitle: "Ready when you are") { ShieldMark(lineWidth: 3).foregroundStyle(Theme.brand) }
                case .selectingRegion:
                    StatusStack(title: "Select the message", subtitle: "Drag around it on screen · Esc to cancel") { ShieldMark(lineWidth: 3).foregroundStyle(Theme.brand) }
                case .cancelled:
                    StatusStack(title: "Scan cancelled", subtitle: "Nothing was captured") { ShieldMark(lineWidth: 3).foregroundStyle(.secondary) }
                case .requestingPermission, .capturing, .processingOCR, .textReady, .sendingForAnalysis:
                    BusyStage(phase: phase, ocrPreparing: ocrPreparing)
                case .safe(let p):
                    SafeResult(presentation: p, onClose: onClose, onShowHistory: onShowHistory)
                case .suspicious(let p):
                    WarningResult(presentation: p, onClose: onClose, onShowHistory: onShowHistory)
                case .failed(let f):
                    FailureResult(failure: f, onClose: onClose, onRetry: onScanAgain, onOpenSettings: onOpenSettings)
                }
            }
            .id(phaseKey)
            .transition(.opacity.combined(with: .scale(scale: 0.97)))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(32)

            // Header strip: drag the card anywhere. Sits below the ✕ button in z-order so the
            // button keeps working; content buttons are never inside this strip.
            WindowDragArea()
                .frame(height: Self.dragHeaderHeight)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .accessibilityHidden(true)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .background(.quaternary, in: Circle())
            }
            .buttonStyle(.plain)
            .focusable(false) // never activatable by Space from keyboard focus
            .padding(14)
            .help("Close (Esc)")
            .accessibilityLabel("Close scanner")
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .background(.regularMaterial)
        .overlay(alignment: .top) { accentBar }
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(.white.opacity(0.08)))
        .animation(.smooth(duration: 0.35), value: phaseKey)
    }

    /// Busy stages share one view (identity "busy") so the stage list animates in place.
    private var phaseKey: String {
        switch phase {
        case .idle: return "idle"
        case .selectingRegion: return "selecting"
        case .cancelled: return "cancelled"
        case .requestingPermission, .capturing, .processingOCR, .textReady, .sendingForAnalysis: return "busy"
        case .safe: return "safe"
        case .suspicious(let p): return "suspicious-\(p.tone.rawValue)"
        case .failed: return "failed"
        }
    }

    @ViewBuilder private var accentBar: some View {
        switch phase {
        case .suspicious(let p):
            Theme.color(for: p.tone).frame(height: 4)
        default:
            EmptyView()
        }
    }
}

// MARK: - Busy states

private struct BusyStage: View {
    let phase: ScannerPhase
    let ocrPreparing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                if !reduceMotion { Ripples(active: true) }
                ShieldMark(lineWidth: 3.5)
                    .foregroundStyle(Theme.brand)
                    .frame(width: 58, height: 70)
            }
            .frame(width: 170, height: 140)
            .windowDraggable()
            VStack(spacing: 4) {
                Text("ScamShield").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary).textCase(.uppercase).tracking(1.5)
                Text(title).font(.system(size: 24, weight: .semibold, design: .rounded))
            }
            .windowDraggable()
            StageList(current: phase.stage ?? .capturing)
            if case .textReady(let summary) = phase {
                Text(summaryLine(summary)).font(.callout).foregroundStyle(.secondary)
            } else {
                LoadingDots(animated: !reduceMotion)
                if case .processingOCR = phase, ocrPreparing {
                    Text("Preparing on-device text recognition (first scan only, may take up to a minute)")
                        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        switch phase {
        case .textReady: return "Text found"
        case .sendingForAnalysis: return "Analyzing…"
        default: return "Scanning…"
        }
    }

    private func summaryLine(_ s: ExtractedTextSummary) -> String {
        var parts = ["\(s.lineCount) line\(s.lineCount == 1 ? "" : "s")"]
        if s.urlCount > 0 { parts.append("\(s.urlCount) link\(s.urlCount == 1 ? "" : "s")") }
        if s.wasTruncated { parts.append("trimmed to 10,000 characters") }
        return parts.joined(separator: " · ")
    }
}

/// Stage-based progress (no invented percentages): done ✓ · current (pulsing) · pending.
private struct StageList: View {
    let current: ScanStage

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(ScanStage.allCases, id: \.self) { stage in
                HStack(spacing: 10) {
                    ZStack {
                        if stage < current {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.color(for: .safe))
                        } else if stage == current {
                            Circle().strokeBorder(Theme.brand, lineWidth: 2).overlay(Circle().fill(Theme.brand).padding(4))
                        } else {
                            Circle().strokeBorder(.tertiary, lineWidth: 1.5)
                        }
                    }
                    .frame(width: 16, height: 16)
                    Text(stage.label)
                        .font(.callout.weight(stage == current ? .semibold : .regular))
                        .foregroundStyle(stage > current ? .tertiary : .primary)
                }
            }
        }
        .animation(.smooth(duration: 0.3), value: current)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(current.rawValue + 1) of \(ScanStage.allCases.count): \(current.label)")
    }
}

/// Shazam-style expanding rings, driven by time so it stays smooth and needs no state.
private struct Ripples: View {
    let active: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: !active)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    let progress = (t / 2.4 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                    Circle()
                        .stroke(Theme.brand.opacity(0.55 * (1 - progress)), lineWidth: 2)
                        .scaleEffect(0.45 + progress * 0.75)
                }
                Circle().fill(Theme.brand.opacity(0.08)).scaleEffect(0.55)
            }
        }
    }
}

private struct LoadingDots: View {
    let animated: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !animated)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 8) {
                ForEach(0..<3, id: \.self) { i in
                    let wave = animated ? (sin(t * 4 - Double(i) * 0.7) + 1) / 2 : 0.5
                    Circle()
                        .fill(Theme.brand)
                        .frame(width: 8, height: 8)
                        .opacity(0.3 + 0.7 * wave)
                        .scaleEffect(0.8 + 0.3 * wave)
                }
            }
        }
        .frame(height: 12)
        .accessibilityHidden(true)
    }
}

// MARK: - Results

private struct SafeResult: View {
    let presentation: ResultPresentation
    let onClose: () -> Void
    let onShowHistory: (() -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Image(systemName: "checkmark")
                .font(.system(size: 40, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 88, height: 88)
                .background(Theme.color(for: .safe), in: Circle())
                .shadow(color: Theme.color(for: .safe).opacity(0.35), radius: 16, y: 6)
                .windowDraggable()
            Text(presentation.headline).font(.system(size: 20, weight: .semibold)).multilineTextAlignment(.center)
            Text(presentation.detail).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            if let score = presentation.riskScore {
                Text("Risk score \(score) / 100 · low").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if !presentation.reasons.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("What was checked").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase).tracking(1)
                    ForEach(presentation.reasons, id: \.self) { Text("• \($0)").font(.callout).fixedSize(horizontal: false, vertical: true) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            if let why = presentation.why {
                Text(why).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("whyColour")
            }
            NotesView(notes: presentation.notes)
            if let why = presentation.why {
                Text(why).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("whyColour")
            }
            NotesView(notes: presentation.notes)
            SourceLine(text: presentation.source)
            if let onShowHistory {
                Button("Details & report…", action: onShowHistory).buttonStyle(.link).font(.caption).focusable(false)
            }
            Spacer(minLength: 0)
            Button("Done", action: onClose).keyboardShortcut(.defaultAction).controlSize(.large)
        }
    }
}

private struct WarningResult: View {
    let presentation: ResultPresentation
    let onClose: () -> Void
    let onShowHistory: (() -> Void)?

    var body: some View {
        let color = Theme.color(for: presentation.tone)
        VStack(spacing: 12) {
            Group {
                if presentation.tone == .danger {
                    Text("!").font(.system(size: 44, weight: .black, design: .rounded))
                } else {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 32, weight: .semibold))
                }
            }
            .foregroundStyle(.white)
            .frame(width: 72, height: 72)
            .background(color, in: Circle())
            .shadow(color: color.opacity(0.4), radius: 16, y: 6)
            .windowDraggable()

            Text(presentation.headline)
                .font(.system(size: presentation.tone == .danger ? 23 : 20, weight: .bold))
                .foregroundStyle(presentation.tone == .danger ? color : .primary)
                .multilineTextAlignment(.center)

            if let score = presentation.riskScore {
                VStack(spacing: 0) {
                    Text("Risk Score").font(.caption).foregroundStyle(.secondary).textCase(.uppercase).tracking(1)
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text("\(score)").font(.system(size: 30, weight: .bold, design: .rounded)).foregroundStyle(color).monospacedDigit()
                        Text("/ 100").font(.callout).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Risk score \(score) out of 100")
            }
            if let category = presentation.categoryLabel {
                Text(category).font(.headline)
            }

            if !presentation.reasons.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Why").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase).tracking(1)
                    ForEach(presentation.reasons, id: \.self) { reason in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("•").foregroundStyle(color)
                            Text(reason).font(.callout).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            if !presentation.actions.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(presentation.actions, id: \.self) { action in
                        Text(action)
                            .font(.callout.weight(presentation.tone == .danger ? .semibold : .regular))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(presentation.detail).font(.callout).foregroundStyle(.secondary)
            }

            SourceLine(text: presentation.source)
            if let onShowHistory {
                Button("Details & report…", action: onShowHistory)
                    .buttonStyle(.link)
                    .font(.caption)
                    .focusable(false)
                    .accessibilityIdentifier("showInHistory")
            }
            Spacer(minLength: 0)
            Button("Dismiss", action: onClose).keyboardShortcut(.defaultAction).controlSize(.large)
        }
    }
}

private struct FailureResult: View {
    let failure: ScannerFailure
    let onClose: () -> Void
    let onRetry: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Image(systemName: icon)
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(Theme.brand)
                .frame(width: 84, height: 84)
                .background(Theme.brand.opacity(0.14), in: Circle())
            Text("Unable to assess").font(.caption.weight(.semibold)).foregroundStyle(.orange).textCase(.uppercase).tracking(1)
                .accessibilityIdentifier("notAssessed")
            Text(failure.title).font(.system(size: 19, weight: .semibold)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            Text(failure.message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            if failure.opensSystemSettings {
                Text("After allowing access, quit and reopen ScamShield.").font(.caption).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            HStack {
                if failure.opensSystemSettings {
                    Button("Open System Settings", action: onOpenSettings).keyboardShortcut(.defaultAction).controlSize(.large)
                    Button("Close", action: onClose).controlSize(.large)
                } else {
                    if failure.canRetry { Button("Try Again", action: onRetry).controlSize(.large) }
                    Button("Close", action: onClose).keyboardShortcut(.defaultAction).controlSize(.large)
                }
            }
        }
    }

    private var icon: String {
        switch failure {
        case .permissionRequired, .permissionDenied: return "lock"
        case .noTextDetected: return "text.magnifyingglass"
        case .analysisServiceUnavailable: return "bolt.horizontal"
        case .cloudAnalysisEnabled: return "icloud.slash"
        default: return "exclamationmark"
        }
    }
}

/// Limits of this check (e.g. ML model unavailable; which screen area the result is about).
private struct NotesView: View {
    let notes: [String]
    var body: some View {
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(notes, id: \.self) { Label($0, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// "Checked on this Mac only." / "+ remote AI (model)" / why the remote AI wasn't used.
private struct SourceLine: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("analysisSource")
        }
    }
}

private struct StatusStack<Icon: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Group {
                icon().frame(width: 70, height: 84)
                Text(title).font(.system(size: 24, weight: .semibold, design: .rounded))
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
            .windowDraggable()
            Spacer(minLength: 0)
        }
    }
}
