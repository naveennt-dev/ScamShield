import SwiftUI
import ScamShieldCore

public struct SettingsView: View {
    @Bindable var store: SettingsStore

    public init(store: SettingsStore) {
        self.store = store
    }

    public static let size = CGSize(width: 520, height: 600)

    public var body: some View {
        Form {
            Section {
                LabeledContent("Backend URL") {
                    HStack {
                        TextField("", text: $store.apiBaseURLText, prompt: Text("http://127.0.0.1:3000"))
                            .textFieldStyle(.roundedBorder)
                            .disabled(store.environmentOverridesURL)
                            .onSubmit { store.saveBaseURL() }
                        Button("Save") { store.saveBaseURL() }.disabled(store.environmentOverridesURL)
                    }
                }
                if let error = store.apiBaseURLError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                if store.environmentOverridesURL {
                    Text("Set by SCAMSHIELD_API_BASE_URL for this launch.").font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Button("Test Connection") { Task { await store.testConnection() } }
                        .disabled(store.connection == .checking)
                    ConnectionLabel(connection: store.connection)
                }
                if let t = store.lastChecked {
                    Text("Last checked \(t.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary)
                }
            } header: {
                Text("Local ScamShield service")
            } footer: {
                Text("The app only talks to a ScamShield service running on this device. It never contacts AI providers directly and stores no API keys.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Picker("Analyse scans", selection: Binding(get: { store.configuration.effectiveAnalysisMode }, set: { store.setAnalysisMode($0) })) {
                    Text("On this device only").tag(AnalysisMode.localOnly)
                    Text("On this device + AI second opinion").tag(AnalysisMode.remoteAssisted)
                }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("analysisModePicker")
                Toggle("Offer “Inspect page behaviour” in Scan Link", isOn: Binding(get: { store.linkInspectionEnabled }, set: { store.linkInspectionEnabled = $0 }))
                    .help("Loads a page in a disposable, isolated browser with test data only — each inspection needs its own click. Off = never offered.")
                if store.configuration.effectiveAnalysisMode == .remoteAssisted {
                    Label("AI second opinion is ON: the masked scan text leaves this device.", systemImage: "network")
                        .foregroundStyle(.orange).font(.callout)
                } else {
                    Label("Local-only: nothing leaves this device.", systemImage: "lock.laptopcomputer")
                        .foregroundStyle(.green).font(.callout)
                }
            } header: {
                Text("Analysis")
            } footer: {
                Text("""
                Why two options: every scan is always checked on this device first (safety rules, ML model, link checks). \
                The AI second opinion additionally asks an AI model, which catches new kinds of fraud the \
                local checks can miss — at the cost of sending the scanned text off this device. You chose on first launch; \
                change it here any time. Sent: only the text read from your scan, with links shortened to their domain \
                and numbers, e-mail addresses and UPI IDs masked. Never screenshots or images. If the AI is offline, slow \
                or rate-limited you get the on-device result. The AI can add a warning but can never make a result look safer.
                """)
                .font(.caption).foregroundStyle(.secondary)
            }

            Section("Keyboard shortcut") {
                Picker("Open scanner", selection: Binding(get: { store.shortcut }, set: { store.setShortcut($0) })) {
                    Text("Off").tag(HotkeyShortcut?.none)
                    ForEach(HotkeyShortcut.presets) { s in
                        Text(s.displayString).tag(Optional(s))
                    }
                }
                if let status = store.shortcutStatus {
                    Text(status).font(.caption).foregroundStyle(.orange)
                }
                if store.shortcut == .default {
                    Text("⇧⌘S is also “Save As…” in many apps; while ScamShield uses it, those apps won’t receive it.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            if !store.loadProblems.isEmpty {
                Section("Configuration problems") {
                    ForEach(store.loadProblems, id: \.self) { problem in
                        Text(problem).font(.caption).foregroundStyle(.orange)
                    }
                }
            }

            ComponentsSection(connection: store.connection, lastChecked: store.lastChecked, screenRecording: store.screenRecordingStatus)
        }
        .formStyle(.grouped)
        .frame(width: Self.size.width, height: Self.size.height)
    }
}

/// What is actually available right now, from the service's live health check (not a static list).
private struct ComponentsSection: View {
    let connection: ConnectionStatus
    let lastChecked: Date?
    let screenRecording: String?

    var body: some View {
        Section {
            row("Screen Recording permission", screenRecording == "granted" ? .ok : .problem, screenRecording.map { $0 == "granted" ? "Granted" : "Not granted — scanning can't capture the screen" } ?? "Unknown")
            switch connection {
            case .online(let h):
                row("Local ScamShield service", h.status == "ok" ? .ok : .warn, h.status == "ok" ? "Running" : "Running (degraded)")
                row("Safety rules + link checks", .ok, "Available")
                row("ML model", h.checks["ml"] == "ok" ? .ok : .warn, ml(h))
                row("Database (web accounts / reports)", h.checks["database"] == "ok" ? .ok : .warn,
                    h.checks["database"] == "ok" ? "Running" : "Unavailable — scanning still works")
                row("AI second opinion", .info, remote(h.checks["llm"]))
            case .offline:
                row("Local ScamShield service", .problem, "Not reachable — scans can't be analysed until it runs")
            case .checking:
                row("Local ScamShield service", .info, "Checking…")
            case .unknown:
                row("Local ScamShield service", .info, "Not checked yet")
            }
        } header: {
            Text("Components")
        } footer: {
            Text("Live status from the service's health check. Scans run only when you start them.").font(.caption).foregroundStyle(.secondary)
        }
    }

    enum State { case ok, warn, problem, info }

    private func row(_ name: String, _ s: State, _ value: String) -> some View {
        LabeledContent {
            Text(value).foregroundStyle(s == .problem ? .red : s == .warn ? .orange : .secondary)
        } label: {
            Label(name, systemImage: s == .ok ? "checkmark.circle.fill" : s == .problem ? "xmark.circle.fill" : s == .warn ? "exclamationmark.triangle.fill" : "info.circle")
                .symbolRenderingMode(.hierarchical)
        }
    }

    private func ml(_ h: BackendHealth) -> String {
        switch (h.checks["ml"], h.checks["mlService"]) {
        case ("ok"?, "ok"?): return "Running (local ML service)"
        case ("ok"?, _): return "Running (built-in fallback model)"
        case ("degraded"?, _): return "Degraded"
        default: return "Unavailable — results use the safety rules only"
        }
    }

    private func remote(_ llm: String?) -> String {
        switch llm {
        case "disabled": return "Off in the service"
        case "opt_in": return "Available — used only if you choose it above"
        case "not_configured": return "Enabled but not configured"
        default: return llm ?? "Unknown"
        }
    }
}

private struct ConnectionLabel: View {
    let connection: ConnectionStatus

    var body: some View {
        switch connection {
        case .unknown:
            EmptyView()
        case .checking:
            ProgressView().controlSize(.small)
        case .online(let health):
            Label("Connected (\(health.status))", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout)
        case .offline(let reason):
            Label(reason, systemImage: "xmark.circle.fill").foregroundStyle(.red).font(.callout).lineLimit(2)
        }
    }
}
