import SwiftUI
import ScamShieldCore

/// "Scan Link": paste a link; it is never opened in your browser.
public struct LinkScanView: View {
    @Bindable var model: LinkScanModel
    let online: Bool
    let inspectionAllowed: Bool

    public init(model: LinkScanModel, online: Bool, inspectionAllowed: Bool) {
        self.model = model
        self.online = online
        self.inspectionAllowed = inspectionAllowed
    }

    public static let size = CGSize(width: 620, height: 640)

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                TextField("Paste a link — it is never opened in your browser", text: $model.input)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .onSubmit { model.start(inspectBehaviour: false) }
                    .accessibilityIdentifier("linkInput")
                Button("Check link") { model.start(inspectBehaviour: false) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.isBusy || model.input.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            HStack(spacing: 8) {
                if online && inspectionAllowed {
                    Button("Inspect page behaviour…") { model.start(inspectBehaviour: true) }
                        .disabled(model.isBusy || model.input.trimmingCharacters(in: .whitespaces).isEmpty)
                        .help("Loads the page in a disposable isolated browser with test data only (10–25 s). Never in your own browser.")
                }
                Text(online ? "Online checks: ScamShield's inspector contacts the website — never with your cookies or accounts." : "On this device only: just the address is analysed; the website is not contacted.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            content
        }
        .padding(16)
        .frame(minWidth: Self.size.width, minHeight: Self.size.height)
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .idle:
            Text("Checks look-alike and international (punycode) names, shorteners and redirects, the page's forms and downloads, YouTube look-alikes and wrappers, threat lists (when configured), the on-device ML model and the AI second opinion (when on).")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Spacer()
        case .scanning(let inspect):
            VStack(alignment: .leading, spacing: 8) {
                ProgressView()
                Text((inspect ? LinkScanModel.inspectStages : LinkScanModel.stages)[model.stage]).font(.callout)
                Button("Cancel") { model.cancel() }
            }
            Spacer()
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            Spacer()
        case .done(let r):
            ScrollView { LinkReportBody(report: r).frame(maxWidth: .infinity, alignment: .leading) }
        }
    }
}

struct LinkReportBody: View {
    let report: LinkReport

    private var tint: Color {
        switch report.verdict {
        case "malicious", "high_risk": return .red
        case "suspicious": return .orange
        case "no_known_threat": return .green
        default: return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(report.verdictLabel).font(.title2.weight(.bold)).foregroundStyle(tint).accessibilityIdentifier("linkVerdict")
                Text(report.summary).font(.callout)
                Text(report.recommendedAction).font(.callout.weight(.medium))
                if let host = report.displayHostname {
                    LabeledContent("Website", value: host == report.hostname ? host : "\(host) (\(report.hostname ?? ""))").font(.caption)
                }
                if report.redirectChain.count > 1, let f = report.finalUrl { LabeledContent("Leads to", value: f).font(.caption) }
                if let note = report.page.youtube.note { Text(note).font(.caption).foregroundStyle(.secondary) }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))

            GroupBox("Findings by type") {
                ForEach(report.categories, id: \.category) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(c.label).font(.callout.weight(.medium))
                            Spacer()
                            Text(c.status == "indicators_found" ? "Warning signs" : c.status == "none_found" ? "None found" : "Not checked")
                                .font(.caption).foregroundStyle(c.status == "indicators_found" ? .red : .secondary)
                        }
                        ForEach(c.evidence, id: \.self) { Text("• \($0)").font(.caption).fixedSize(horizontal: false, vertical: true) }
                    }
                    .padding(.vertical, 2)
                }
            }
            if !report.evidence.isEmpty {
                GroupBox("Evidence") {
                    ForEach(Array(report.evidence.enumerated()), id: \.offset) { _, e in
                        HStack(alignment: .top) {
                            Text(kindLabel(e.kind)).font(.caption2.weight(.semibold)).padding(.horizontal, 4)
                                .background((e.kind == "confirmed_intel" || e.kind == "observed_behaviour" ? Color.red : e.kind == "ai_opinion" ? Color.purple : Color.gray).opacity(0.15), in: Capsule())
                            Text(e.detail).font(.caption).fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            if let d = report.dynamic {
                GroupBox("Page behaviour (isolated browser)") {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.detail ?? d.status).font(.caption).foregroundStyle(.secondary)
                        Text("Observed for \(Int(d.observedWindowMs / 1000)) s · \(d.requests.total) requests to \(d.requests.thirdPartyHosts.count) other websites").font(.caption)
                        Text("Typed test data sent away: \(d.typedDataSentTo.isEmpty ? "not observed" : d.typedDataSentTo.joined(separator: ", "))").font(.caption)
                        Text("Downloads tried: \(d.downloadsAttempted.isEmpty ? "none" : d.downloadsAttempted.joined(separator: ", ")) · Permissions asked: \(d.permissionRequests.isEmpty ? "none" : d.permissionRequests.joined(separator: ", "))").font(.caption)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            DisclosureGroup("What was checked, limitations and what left this device") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(report.coverage, id: \.id) { c in
                        HStack(alignment: .top) {
                            Text(c.label).font(.caption).frame(width: 190, alignment: .leading)
                            Text(statusLabel(c.status)).font(.caption).foregroundStyle(c.status == "failed" ? .red : c.status == "done" ? .green : .secondary).frame(width: 90, alignment: .leading)
                            Text(c.detail ?? "").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    ForEach(report.limitations, id: \.self) { Text("• \($0)").font(.caption).fixedSize(horizontal: false, vertical: true) }
                    Text(report.disclosures.isEmpty ? "Nothing left this device." : report.disclosures.joined(separator: "\n")).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.top, 4)
            }
            .font(.callout)
        }
    }

    private func kindLabel(_ k: String) -> String {
        switch k {
        case "confirmed_intel": return "CONFIRMED"
        case "observed_behaviour": return "OBSERVED"
        case "ai_opinion": return "AI OPINION"
        default: return "WARNING SIGN"
        }
    }

    private func statusLabel(_ s: String) -> String {
        ["done": "Checked", "skipped": "Skipped", "failed": "Failed", "unavailable": "Unavailable", "not_applicable": "Not applicable"][s] ?? s
    }
}
