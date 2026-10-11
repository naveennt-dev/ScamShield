import Foundation

/// A global keyboard shortcut, stored as a Carbon virtual key code + modifiers so it can be
/// registered with `RegisterEventHotKey` (no Accessibility permission needed).
public struct HotkeyShortcut: Codable, Hashable, Sendable, Identifiable {
    public enum Modifier: String, Codable, Hashable, Sendable, CaseIterable {
        case control, option, shift, command

        /// Carbon modifier masks (Events.h): cmdKey 0x0100, shiftKey 0x0200, optionKey 0x0800, controlKey 0x1000.
        var carbonMask: UInt32 {
            switch self {
            case .command: return 0x0100
            case .shift: return 0x0200
            case .option: return 0x0800
            case .control: return 0x1000
            }
        }

        var symbol: String {
            switch self {
            case .control: return "⌃"
            case .option: return "⌥"
            case .shift: return "⇧"
            case .command: return "⌘"
            }
        }
    }

    public var keyCode: UInt32
    public var modifiers: Set<Modifier>

    public init(keyCode: UInt32, modifiers: Set<Modifier>) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    public var id: String { "\(keyCode)-\(modifiers.map(\.rawValue).sorted().joined(separator: "+"))" }

    public var carbonModifiers: UInt32 {
        modifiers.reduce(0) { $0 | $1.carbonMask }
    }

    /// Human-readable form in Apple's canonical modifier order, e.g. "⇧⌘S".
    public var displayString: String {
        Modifier.allCases.filter(modifiers.contains).map(\.symbol).joined() + (Self.keyNames[keyCode] ?? "?")
    }

    /// A global shortcut must include ⌘, ⌃ or ⌥ — shift alone would swallow normal typing.
    public var isValidGlobalShortcut: Bool {
        !modifiers.intersection([.command, .control, .option]).isEmpty && Self.keyNames[keyCode] != nil
    }

    // Carbon kVK_ANSI_* codes for the keys offered in Settings.
    static let keyNames: [UInt32: String] = [0x01: "S", 0x02: "D", 0x0F: "R", 0x13: "2", 0x14: "3"]

    /// Default requested for Phase 1. Note: ⇧⌘S is also "Save As…" in many apps; while ScamShield
    /// holds it globally, those apps won't receive it. Users can pick another preset in Settings.
    public static let `default` = HotkeyShortcut(keyCode: 0x01, modifiers: [.command, .shift])

    public static let presets: [HotkeyShortcut] = [
        .default,
        HotkeyShortcut(keyCode: 0x01, modifiers: [.control, .option]),
        HotkeyShortcut(keyCode: 0x01, modifiers: [.control, .option, .command]),
        HotkeyShortcut(keyCode: 0x02, modifiers: [.control, .option]),
        HotkeyShortcut(keyCode: 0x14, modifiers: [.control, .shift, .command]),
    ]
}
