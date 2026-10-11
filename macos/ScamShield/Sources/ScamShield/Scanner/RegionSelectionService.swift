import AppKit
import ScamShieldCore

extension NSScreen {
    /// CoreGraphics display ID, shared with ScreenCaptureKit's `SCDisplay.displayID`.
    var displayID: UInt32? {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }
}

/// Region selection with one transparent overlay window per display (multi-monitor).
///
/// Each overlay window covers exactly its screen's frame, and its view is flipped, so a point in
/// the view is already a display-local, top-left coordinate in points — the coordinate space
/// ScreenCaptureKit's `sourceRect` uses. Pixel size = points × that screen's backing scale.
@MainActor
final class RegionSelectionService: CaptureTargetSelecting {
    private(set) var windows: [SelectionOverlayWindow] = []
    private var continuation: CheckedContinuation<CaptureTarget?, Never>?
    private var previousApp: NSRunningApplication?

    var isPresenting: Bool { continuation != nil }

    func currentDisplayTarget() -> CaptureTarget? {
        guard let screen = Self.screenUnderPointer(), let id = screen.displayID else { return nil }
        return CaptureTarget(kind: .fullDisplay, displayID: id, sourceRect: CGRect(origin: .zero, size: screen.frame.size), pointPixelScale: screen.backingScaleFactor)
    }

    func selectRegion() async -> CaptureTarget? {
        guard continuation == nil else { return nil }
        return await withCheckedContinuation { cont in
            continuation = cont
            present()
        }
    }

    func cancel() {
        finish(nil)
    }

    static func screenUnderPointer() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    }

    private func present() {
        previousApp = NSWorkspace.shared.frontmostApplication
        let pointerScreen = Self.screenUnderPointer()
        for screen in NSScreen.screens {
            guard let id = screen.displayID else { continue }
            let window = SelectionOverlayWindow(screen: screen, displayID: id, service: self)
            windows.append(window)
            window.orderFrontRegardless()
        }
        // Key events (Esc/Return) go to the overlay on the screen the user is looking at.
        NSApp.activate()
        (windows.first { $0.screen == pointerScreen } ?? windows.first)?.makeKey()
        NSCursor.crosshair.push()
    }

    /// Called by a view when the user starts dragging, so only one display holds a selection.
    func didBeginSelection(in window: SelectionOverlayWindow) {
        for w in windows where w !== window { w.selectionView.reset() }
        window.makeKey()
    }

    func confirm(_ localRect: CGRect, in window: SelectionOverlayWindow) {
        guard let screen = window.screen,
              let rect = CaptureGeometry.normalized(localRect, displaySize: screen.frame.size, scale: screen.backingScaleFactor),
              CaptureGeometry.isValidSelection(rect) else { return }
        finish(CaptureTarget(kind: .region, displayID: window.displayID, sourceRect: rect, pointPixelScale: screen.backingScaleFactor))
    }

    private func finish(_ target: CaptureTarget?) {
        guard let cont = continuation else { return }
        continuation = nil
        NSCursor.pop()
        for w in windows { w.orderOut(nil) }
        windows.removeAll()
        // Give focus back to the app the user was reading, so the scanner card doesn't steal it.
        if target == nil { previousApp?.activate() }
        cont.resume(returning: target)
    }
}

final class SelectionOverlayWindow: NSWindow {
    let displayID: UInt32
    let selectionView: SelectionView

    init(screen: NSScreen, displayID: UInt32, service: RegionSelectionService) {
        self.displayID = displayID
        selectionView = SelectionView(frame: NSRect(origin: .zero, size: screen.frame.size))
        super.init(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        setFrame(screen.frame, display: false)
        level = .screenSaver
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = false
        acceptsMouseMovedEvents = true
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        title = "ScamShield Region Selection"
        setAccessibilityIdentifier("scamshield.region-overlay")
        selectionView.owner = self
        selectionView.service = service
        selectionView.scale = screen.backingScaleFactor
        contentView = selectionView
        makeFirstResponder(selectionView)
    }

    override var canBecomeKey: Bool { true }
}

/// Dims the display, draws the selection with a clear "cut-out", a pixel-size label, and
/// Scan / Cancel buttons after the drag. Flipped: (0,0) is the display's top-left corner.
final class SelectionView: NSView {
    weak var owner: SelectionOverlayWindow?
    weak var service: RegionSelectionService?
    var scale: CGFloat = 2

    private(set) var selection: CGRect?
    private var anchor: CGPoint?
    private var isDragging = false
    private lazy var scanButton = makeButton("Scan", action: #selector(confirmSelection), primary: true)
    private lazy var cancelButton = makeButton("Cancel", action: #selector(cancelSelection), primary: false)

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    private func makeButton(_ title: String, action: Selector, primary: Bool) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        b.controlSize = .large
        if primary { b.keyEquivalent = "\r" }
        b.isHidden = true
        addSubview(b)
        return b
    }

    func reset() {
        selection = nil
        anchor = nil
        isDragging = false
        updateButtons()
        needsDisplay = true
    }

    private func clamp(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(p.x, 0), bounds.width), y: min(max(p.y, 0), bounds.height))
    }

    // MARK: Mouse

    override func mouseDown(with event: NSEvent) {
        let p = clamp(convert(event.locationInWindow, from: nil))
        if event.clickCount == 2, let sel = selection, sel.contains(p) {
            confirmSelection()
            return
        }
        if let owner { service?.didBeginSelection(in: owner) }
        anchor = p
        selection = nil
        isDragging = true
        updateButtons()
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let anchor else { return }
        selection = CaptureGeometry.rect(from: anchor, to: clamp(convert(event.locationInWindow, from: nil)))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        isDragging = false
        if let s = selection, !CaptureGeometry.isValidSelection(s) { selection = nil }
        updateButtons()
        needsDisplay = true
    }

    // MARK: Keys

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53: cancelSelection() // Esc
        case 36, 76: confirmSelection() // Return / Enter
        default: super.keyDown(with: event)
        }
    }

    override func cancelOperation(_ sender: Any?) {
        cancelSelection()
    }

    @objc func confirmSelection() {
        guard let selection, let owner, CaptureGeometry.isValidSelection(selection) else { return }
        service?.confirm(selection, in: owner)
    }

    @objc func cancelSelection() {
        service?.cancel()
    }

    // MARK: Drawing

    private func updateButtons() {
        guard let sel = selection, !isDragging, CaptureGeometry.isValidSelection(sel) else {
            scanButton.isHidden = true
            cancelButton.isHidden = true
            return
        }
        scanButton.sizeToFit()
        cancelButton.sizeToFit()
        let gap: CGFloat = 8
        let total = scanButton.frame.width + cancelButton.frame.width + gap
        var y = sel.maxY + 12
        if y + scanButton.frame.height > bounds.height - 8 { y = max(8, sel.minY - scanButton.frame.height - 12) }
        var x = sel.maxX - total
        x = min(max(8, x), bounds.width - total - 8)
        cancelButton.setFrameOrigin(NSPoint(x: x, y: y))
        scanButton.setFrameOrigin(NSPoint(x: x + cancelButton.frame.width + gap, y: y))
        scanButton.isHidden = false
        cancelButton.isHidden = false
    }

    override func draw(_ dirtyRect: NSRect) {
        let dim = NSBezierPath(rect: bounds)
        if let sel = selection {
            dim.append(NSBezierPath(roundedRect: sel, xRadius: 6, yRadius: 6))
            dim.windingRule = .evenOdd
        }
        NSColor.black.withAlphaComponent(0.38).setFill()
        dim.fill()

        if let sel = selection {
            let border = NSBezierPath(roundedRect: sel.insetBy(dx: -1, dy: -1), xRadius: 7, yRadius: 7)
            border.lineWidth = 2
            NSColor.white.withAlphaComponent(0.95).setStroke()
            border.stroke()
            // Label the exact pixels that will be captured (selection snapped to the pixel grid).
            let displaySize = window?.screen?.frame.size ?? bounds.size
            let captured = CaptureGeometry.normalized(sel, displaySize: displaySize, scale: scale) ?? sel
            drawLabel(CaptureGeometry.sizeLabel(for: captured, scale: scale), above: sel)
        } else {
            drawHint()
        }
    }

    private func drawLabel(_ text: String, above sel: CGRect) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
        let str = NSAttributedString(string: text, attributes: attrs)
        let size = str.size()
        var origin = CGPoint(x: sel.minX, y: sel.minY - size.height - 10)
        if origin.y < 4 { origin.y = sel.minY + 6; origin.x += 6 }
        let pill = CGRect(x: origin.x, y: origin.y, width: size.width + 14, height: size.height + 6)
        NSColor.black.withAlphaComponent(0.7).setFill()
        NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2).fill()
        str.draw(at: CGPoint(x: pill.minX + 7, y: pill.minY + 3))
    }

    private func drawHint() {
        let title = NSAttributedString(string: "Select the message", attributes: [
            .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
            .foregroundColor: NSColor.white,
        ])
        let sub = NSAttributedString(string: "Drag around the text you want to check  ·  Esc to cancel", attributes: [
            .font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: NSColor.white.withAlphaComponent(0.8),
        ])
        let tSize = title.size(), sSize = sub.size()
        let width = max(tSize.width, sSize.width) + 48
        let box = CGRect(x: bounds.midX - width / 2, y: bounds.height * 0.12, width: width, height: tSize.height + sSize.height + 30)
        NSColor.black.withAlphaComponent(0.55).setFill()
        NSBezierPath(roundedRect: box, xRadius: 14, yRadius: 14).fill()
        title.draw(at: CGPoint(x: box.midX - tSize.width / 2, y: box.minY + 12))
        sub.draw(at: CGPoint(x: box.midX - sSize.width / 2, y: box.minY + 16 + tSize.height))
    }

    // MARK: Test hooks (self-test drives the real view)

    func simulateDrag(from a: CGPoint, to b: CGPoint) {
        anchor = clamp(a)
        isDragging = true
        selection = CaptureGeometry.rect(from: clamp(a), to: clamp(b))
        isDragging = false
        if let s = selection, !CaptureGeometry.isValidSelection(s) { selection = nil }
        updateButtons()
        needsDisplay = true
    }

    var areButtonsVisible: Bool { !scanButton.isHidden && !cancelButton.isHidden }
}
