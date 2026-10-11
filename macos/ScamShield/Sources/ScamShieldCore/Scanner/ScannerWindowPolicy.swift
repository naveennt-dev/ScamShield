import AppKit

/// Window level of the floating scanner card for "Keep the scanner above other windows".
public enum ScannerWindowPolicy {
    /// ON: utility-panel level — above document windows, below menus, Spotlight and alerts.
    /// OFF: an ordinary window that other apps' windows can cover.
    public static func level(alwaysOnTop: Bool) -> NSWindow.Level {
        alwaysOnTop ? .floating : .normal
    }
}
