import AppKit
import os
import SwiftUI

/// Transparent region that moves its window when dragged (the scanner card is borderless, so it
/// has no title bar).
///
/// The drag is tracked explicitly: mouse-down records the pointer and window origin, every
/// mouse-dragged event moves the REAL window (`setFrameOrigin`) by the pointer's delta, mouse-up
/// ends it. (Phase 3 used `NSWindow.performDrag`, a window-server drag that did not move this
/// non-activating panel of a menu-bar-only app when tried with a real mouse.)
///
/// Dragging never makes the panel key (`needsPanelToBecomeKey == false` with the panel's
/// `becomesKeyOnlyIfNeeded`), so moving the card mid-scan doesn't pull keyboard focus away from
/// the app the user is typing in.
public struct WindowDragArea: NSViewRepresentable {
    public init() {}

    public func makeNSView(context: Context) -> WindowDragView { WindowDragView() }
    public func updateNSView(_ nsView: WindowDragView, context: Context) {}
}

public final class WindowDragView: NSView {
    /// Where the pointer is, in screen coordinates. The real cursor in the app; the self-test
    /// substitutes scripted positions while sending real mouse events through AppKit.
    @MainActor public static var pointerLocation: () -> NSPoint = { NSEvent.mouseLocation }
    /// Called when a drag ends (origin before → after). Diagnostics only; no content.
    @MainActor public static var onDragEnded: ((NSPoint, NSPoint) -> Void)?
    private static let log = Logger(subsystem: "dev.scamshield.mac", category: "window")

    private var start: (pointer: NSPoint, origin: NSPoint)?

    public override var mouseDownCanMoveWindow: Bool { false } // we move it ourselves
    public override var needsPanelToBecomeKey: Bool { false }
    public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    public override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        start = (Self.pointerLocation(), window.frame.origin)
        NSCursor.closedHand.set()
        Self.log.notice("scanner drag began at origin \(String(describing: window.frame.origin), privacy: .public)")
    }

    public override func mouseDragged(with event: NSEvent) {
        guard let window, let start else { return }
        let p = Self.pointerLocation()
        window.setFrameOrigin(NSPoint(x: start.origin.x + p.x - start.pointer.x, y: start.origin.y + p.y - start.pointer.y))
    }

    public override func mouseUp(with event: NSEvent) {
        endDrag(reason: "mouse up")
    }

    /// SwiftUI may replace this view while a drag is in progress (the scan moved to its next
    /// stage); the drag must still end cleanly — the window keeps the position it reached.
    public override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil { endDrag(reason: "handle removed during state change") }
        super.viewWillMove(toWindow: newWindow)
    }

    private func endDrag(reason: String) {
        guard let start else { return }
        self.start = nil
        NSCursor.arrow.set()
        let end = window?.frame.origin ?? start.origin
        Self.log.notice("scanner drag ended (\(reason, privacy: .public)): origin \(String(describing: start.origin), privacy: .public) → \(String(describing: end), privacy: .public)")
        Self.onDragEnded?(start.origin, end)
    }

    public override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    public override func isAccessibilityElement() -> Bool { false }
}

public extension View {
    /// Makes this (non-interactive) view a handle that drags its window.
    func windowDraggable() -> some View {
        overlay(WindowDragArea())
    }
}
