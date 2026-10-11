import SwiftUI
import ScamShieldCore

/// Transient UI state of the History window (an @Observable model rather than @State, which
/// needs a SwiftUI macro plugin the Command Line Tools toolchain doesn't ship).
@MainActor
@Observable
public final class HistoryUIState {
    public var confirmClear = false
    public var reportError: String?
    public init() {}
}

/// Local scan history + per-result reports. Everything shown here lives only on this Mac.
public struct HistoryView: View {
    @Bindable var history: HistoryStore
    @Bindable var reports: ReportStore
    @Binding var selection: UUID?
    @Bindable var ui: HistoryUIState
    let contributions: ContributionOutbox?
    /// Called after feedback is saved (used to send opt-in contributions).
    let onFeedbackSaved: () -> Void

    public init(history: HistoryStore, reports: ReportStore, selection: Binding<UUID?>, ui: HistoryUIState,
                contributions: ContributionOutbox? = nil, onFeedbackSaved: @escaping () -> Void = {}) {
        self.history = history
        self.reports = reports
        self._selection = selection
        self.ui = ui
        self.contributions = contributions
        self.onFeedbackSaved = onFeedbackSaved
    }

    public static let size = CGSize(width: 760, height: 520)

    public var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                if let e = history.lastError { Label(e, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
                ForEach(history.entries) { entry in
                    HistoryRow(entry: entry, reported: reports.report(for: entry.id) != nil).tag(entry.id)
                        .contextMenu { Button("Delete", role: .destructive) { delete(entry.id) } }
                }
            }
            .overlay {
                if history.entries.isEmpty {
                    ContentUnavailableView("No scans yet", systemImage: "clock",
                                           description: Text(history.isEnabled ? "Results of scans you start appear here." : "History is turned off."))
                }
            }
            .navigationSplitViewColumnWidth(min: 260, ideal: 290)
            .toolbar {
                ToolbarItem {
                    Button(role: .destructive) { ui.confirmClear = true } label: { Label("Clear All", systemImage: "trash") }
                        .disabled(history.entries.isEmpty)
                        .help("Delete all scan history and your local reports")
                        .accessibilityIdentifier("historyClearAll")
                }
            }
        } detail: {
            if let id = selection, let entry = history.entry(id) {
                HistoryDetail(entry: entry, report: reports.report(for: id), reportError: ui.reportError,
                              onReport: { verdict in
                                  do {
                                      try reports.submit(verdict, for: entry)
                                      ui.reportError = nil
                                      if contributions?.enqueue(verdict, for: entry) == true { onFeedbackSaved() }
                                  }
                                  catch ReportStore.ReportError.rateLimited { ui.reportError = "You've sent many reports today — try again tomorrow." }
                                  catch { ui.reportError = reports.lastError ?? "The report couldn't be saved." }
                              },
                              onRemoveReport: { reports.deleteReports(forEntry: id) },
                              onDelete: { delete(id) },
                              contributions: contributions)
            } else {
                HistorySettingsPanel(history: history, contributions: contributions)
            }
        }
        .confirmationDialog("Delete all scan history?", isPresented: $ui.confirmClear, titleVisibility: .visible) {
            Button("Delete All", role: .destructive) {
                history.clearAll()
                reports.clearAll()
                selection = nil
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes every saved result and your local reports from this device. It can't be undone.")
        }
        .frame(minWidth: Self.size.width, minHeight: Self.size.height)
    }

    private func delete(_ id: UUID) {
        history.delete(id)
        reports.deleteReports(forEntry: id)
        if selection == id { selection = nil }
    }
}

private struct HistoryRow: View {
    let entry: HistoryEntry
    let reported: Bool

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(entry.completed ? Theme.color(for: tone) : Color.gray).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.completed ? (entry.categoryLabel ?? entry.headline) : "Unable to assess").font(.callout.weight(.medium)).lineLimit(1)
                Text(entry.date, format: .dateTime.day().month().hour().minute()).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if reported { Image(systemName: "flag.fill").font(.caption2).foregroundStyle(.secondary).help("You reported this result") }
            if let score = entry.riskScore { Text("\(score)").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(Theme.color(for: tone)) }
        }
        .padding(.vertical, 2)
    }

    private var tone: ResultPresentation.Tone {
        switch entry.riskLevel { case .safe?, nil: return .safe; case .suspicious?: return .caution; default: return .danger }
    }
}

private struct HistoryDetail: View {
    let entry: HistoryEntry
    let report: LocalReport?
    let reportError: String?
    let onReport: (LocalReport.Verdict) -> Void
    let onRemoveReport: () -> Void
    let onDelete: () -> Void
    var contributions: ContributionOutbox? = nil

    var body: some View {
        Form {
            Section {
                LabeledContent("Result", value: entry.headline)
                if let level = entry.riskLevel { LabeledContent("Level", value: level.rawValue.capitalized) }
                if let score = entry.riskScore { LabeledContent("Risk score", value: "\(score) / 100") }
                if let failure = entry.failure { LabeledContent("Not assessed because", value: failure) }
                if let c = entry.categoryLabel { LabeledContent("Type", value: c) }
                LabeledContent("When") { Text(entry.date, format: .dateTime) }
                LabeledContent("Scanned", value: entry.captureMode.map { $0 == .region ? "Selected region" : $0 == .link ? "Link" : "Full screen" } ?? "Not recorded (older entry)")
                if !entry.source.isEmpty { LabeledContent("Checked", value: entry.displaySource) }
                LabeledContent("Scan ID", value: String(entry.scanID.uuidString.prefix(8))).font(.caption)
            }
            if !entry.reasons.isEmpty {
                Section("Why") { ForEach(entry.reasons, id: \.self) { Text($0).font(.callout) } }
            }
            if !entry.linkHosts.isEmpty {
                Section("Links (website names only — not opened)") { ForEach(entry.linkHosts, id: \.self) { Text($0).font(.callout.monospaced()).textSelection(.enabled) } }
            }
            if let d = entry.decision {
                Section("Why this colour") {
                    Text(d.why).font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                    if !d.matches.isEmpty {
                        ForEach(Array(d.matches.enumerated()), id: \.offset) { _, m in
                            VStack(alignment: .leading, spacing: 2) {
                                Label(m.rule, systemImage: m.severity == "high" ? "exclamationmark.triangle.fill" : "exclamationmark.circle")
                                    .font(.callout).foregroundStyle(m.severity == "high" ? .red : .orange)
                                Text("Matched: \u{201C}\(m.text)\u{201D}").font(.caption.monospaced()).foregroundStyle(.secondary)
                                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    ForEach(d.basis, id: \.self) { Text("• \($0)").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                }
            }
            Section("Scanned text") {
                if let t = entry.text ?? entry.excerpt {
                    Text(t).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("Numbers (OTPs, card, account, phone), e-mail addresses, UPI IDs and link paths are masked. Stored only on this device.")
                        .font(.caption).foregroundStyle(.tertiary)
                } else {
                    Text("Not stored for this scan (\"Save the scanned text\" was off, or the scan was made before text saving existed).")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Section {
                if let report {
                    LabeledContent("Your feedback", value: report.verdict.title(for: report.riskLevel))
                    Button("Remove my report", action: onRemoveReport)
                } else if entry.completed {
                    HStack {
                        ForEach(LocalReport.Verdict.options(for: entry.riskLevel), id: \.self) { v in Button(v.title(for: entry.riskLevel)) { onReport(v) } }
                    }
                } else {
                    Text("Incomplete scans can't be reported.").font(.caption).foregroundStyle(.secondary)
                }
                if let reportError { Text(reportError).font(.caption).foregroundStyle(.orange) }
            } header: {
                Text("Your feedback on this result")
            } footer: {
                Text(contributions?.isEnabled == true
                     ? """
                     Saved on this device. "Share my feedback" is on, so your choice is also sent with this scan's masked text \
                     to the ScamShield service you're connected to, where it is quarantined for review. Never the screenshot. \
                     It doesn't change how ScamShield scores messages by itself.
                     """
                     : """
                     Saved only on this device (in your user's Application Support folder) and never uploaded. Your feedback \
                     stores your choice, the date, and this result's level, score, type and website names — not the message \
                     text or the screenshot. It doesn't change how ScamShield scores other messages.
                     """)
                .font(.caption).foregroundStyle(.secondary)
            }
            Section { Button("Delete this entry", role: .destructive, action: onDelete) }
        }
        .formStyle(.grouped)
    }
}

/// Shown when nothing is selected: what history keeps, and its settings.
struct HistorySettingsPanel: View {
    @Bindable var history: HistoryStore
    let contributions: ContributionOutbox?

    var body: some View {
        Form {
            Section {
                Toggle("Keep a history of my scans", isOn: $history.isEnabled)
                Toggle("Save the scanned text (numbers masked)", isOn: $history.saveText)
                    .disabled(!history.isEnabled)
                Picker("Keep results for", selection: $history.retentionDays) {
                    ForEach(HistoryStore.retentionChoices, id: \.self) { Text("\($0) days").tag($0) }
                }
                .disabled(!history.isEnabled)
            } header: {
                Text("Scan history")
            } footer: {
                Text("""
                Stored only on this device, readable only by your user account: \(history.fileURL.deletingLastPathComponent().path). \
                Each entry keeps the date, result, score, the reasons and why it got its colour (the exact words that matched), \
                website names and whether the AI was used. With "Save the scanned text" on (the default), the text is kept too, \
                with OTPs, card/account/phone numbers, e-mail addresses, UPI IDs and link paths masked. Screenshots are never \
                saved. Up to \(HistoryStore.maxEntries) entries; older ones are removed automatically.
                """)
                .font(.caption).foregroundStyle(.secondary)
            }
            if let contributions { ShareFeedbackSection(outbox: contributions, textSaved: history.saveText) }
        }
        .formStyle(.grouped)
    }
}

struct ShareFeedbackSection: View {
    @Bindable var outbox: ContributionOutbox
    let textSaved: Bool

    var body: some View {
        Section {
            Toggle("Share my feedback to improve detection", isOn: $outbox.isEnabled)
                .accessibilityIdentifier("shareFeedbackToggle")
            if outbox.isEnabled {
                LabeledContent("Waiting to be shared", value: "\(outbox.pending.count)")
                if let s = outbox.lastStatus { Text(s).font(.caption).foregroundStyle(.secondary) }
                if !outbox.pending.isEmpty { Button("Delete queued feedback", role: .destructive) { outbox.clear() } }
                if !textSaved { Text("\"Save the scanned text\" is off, so there is nothing to share.").font(.caption).foregroundStyle(.orange) }
            }
        } header: {
            Text("Help improve ScamShield (optional)")
        } footer: {
            Text("""
            Off by default. When on, the feedback you give on a result (correct / missed scam / false alarm / not sure) \
            is shared together with that scan's masked text — numbers, e-mail addresses, UPI IDs and link paths removed. \
            Never screenshots, never your History. It goes to the ScamShield service you are connected to, where it is \
            kept in quarantine and reviewed; it never changes the detection model by itself. Turning this off deletes \
            anything still queued.
            """)
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}
