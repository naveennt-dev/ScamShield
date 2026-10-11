import SwiftUI
import ScamShieldCore

/// Contents of the menu-bar popover.
public struct MenuBarView: View {
    public struct Actions {
        public var scanScreen: () -> Void
        public var selectRegion: () -> Void
        public var openSettings: () -> Void
        public var quit: () -> Void
        public var openHistory: () -> Void
        public var scanLink: () -> Void

        public init(
            scanScreen: @escaping () -> Void,
            selectRegion: @escaping () -> Void,
            openSettings: @escaping () -> Void,
            quit: @escaping () -> Void,
            openHistory: @escaping () -> Void = {},
            scanLink: @escaping () -> Void = {}
        ) {
            self.scanLink = scanLink
            self.scanScreen = scanScreen
            self.selectRegion = selectRegion
            self.openSettings = openSettings
            self.quit = quit
            self.openHistory = openHistory
        }
    }

    let shortcut: HotkeyShortcut?
    let connection: ConnectionStatus
    let analysisMode: AnalysisMode
    let actions: Actions
    /// Shows this row highlighted as if hovered (developer UI captures only; nil in the app).
    let highlightedRow: String?
    @Environment(\.colorScheme) private var scheme

    public init(shortcut: HotkeyShortcut?, connection: ConnectionStatus, analysisMode: AnalysisMode = .localOnly,
                highlightedRow: String? = nil, actions: Actions) {
        self.highlightedRow = highlightedRow
        self.shortcut = shortcut
        self.connection = connection
        self.analysisMode = analysisMode
        self.actions = actions
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                ShieldMark(lineWidth: 2).foregroundStyle(Theme.brand).frame(width: 22, height: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text("ScamShield").font(.system(size: 15, weight: .semibold))
                    Label(analysisMode == .localOnly ? "Local-only analysis" : "Remote AI assist on",
                          systemImage: analysisMode == .localOnly ? "lock.laptopcomputer" : "network")
                        .font(.caption2)
                        .foregroundStyle(analysisMode == .localOnly ? Theme.secondaryText : AnyShapeStyle(GlassSupport.isAvailable ? Theme.textColor(for: .caution, scheme: scheme) : Color.orange))
                        .accessibilityIdentifier("menuAnalysisMode")
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider().padding(.horizontal, 8)

            VStack(spacing: 2) {
                MenuRow("Scan Screen", systemImage: "viewfinder", shortcut: shortcut?.displayString, forced: highlightedRow, action: actions.scanScreen)
                MenuRow("Select Region", systemImage: "crop", action: actions.selectRegion)
                MenuRow("Scan Link…", systemImage: "link", action: actions.scanLink)
            }
            .padding(6)

            Divider().padding(.horizontal, 8)

            VStack(spacing: 2) {
                MenuRow("History…", systemImage: "clock.arrow.circlepath", action: actions.openHistory)
                MenuRow("Settings…", systemImage: "gearshape", shortcut: "⌘,", action: actions.openSettings)
                MenuRow("Quit ScamShield", systemImage: "power", shortcut: "⌘Q", action: actions.quit)
            }
            .padding(6)

            ConnectionFooter(connection: connection)
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
                .padding(.top, 2)
        }
        .frame(width: 260)
        .menuReadabilityBacking()
    }
}

/// Hover state holder. (`@State` is a macro in the macOS 27 SDK whose plugin ships only with Xcode;
/// this package must build with the Command Line Tools alone, so view-local state uses `@StateObject`.)
final class HoverState: ObservableObject {
    @Published var isHovering = false
}

private struct MenuRow: View {
    let title: String
    let systemImage: String
    let shortcut: String?
    let action: () -> Void
    let forced: String?
    @StateObject private var hover = HoverState()
    private var hovering: Bool { hover.isHovering || forced == title }

    init(_ title: String, systemImage: String, shortcut: String? = nil, forced: String? = nil, action: @escaping () -> Void) {
        self.forced = forced
        self.title = title
        self.systemImage = systemImage
        self.shortcut = shortcut
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage).frame(width: 18).foregroundStyle(hovering ? AnyShapeStyle(.white) : Theme.secondaryText)
                Text(title)
                Spacer()
                if let shortcut { Text(shortcut).foregroundStyle(hovering ? AnyShapeStyle(.white.opacity(GlassSupport.isAvailable ? 1 : 0.8)) : Theme.secondaryText).font(.callout) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundStyle(hovering ? .white : .primary)
            .menuRowHighlight(hovering)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover.isHovering = $0 }
    }
}

private struct ConnectionFooter: View {
    let connection: ConnectionStatus

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private var label: String {
        switch connection {
        case .unknown: return "Local service: not checked"
        case .checking: return "Local service: checking…"
        case .online(let h): return h.status == "ok" ? "Local service: online" : "Local service: online (degraded)"
        case .offline: return "Local service: offline"
        }
    }

    private var color: Color {
        switch connection {
        case .online(let h): return h.status == "ok" ? .green : .orange
        case .offline: return .red
        default: return .secondary
        }
    }
}
