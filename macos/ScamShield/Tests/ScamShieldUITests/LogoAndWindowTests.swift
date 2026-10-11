import AppKit
import SwiftUI
import Testing
@testable import ScamShieldCore
@testable import ScamShieldUI

/// Rasterises a path into a w×h coverage mask (row 0 = top, like SwiftUI).
private func mask(width w: Int, height h: Int, draw: (CGContext) -> Void) -> [[Bool]] {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1) // y down
    ctx.setFillColor(gray: 1, alpha: 1); ctx.setStrokeColor(gray: 1, alpha: 1)
    draw(ctx)
    let buf = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h)
    return (0..<h).map { y in (0..<w).map { x in buf[y * w + x] > 127 } }
}

private func centroid(_ m: [[Bool]]) -> CGPoint {
    var n = 0.0, sx = 0.0, sy = 0.0
    for (y, row) in m.enumerated() { for (x, on) in row.enumerated() where on { n += 1; sx += Double(x) + 0.5; sy += Double(y) + 0.5 } }
    return CGPoint(x: sx / n, y: sy / n)
}

private func boundingBoxCenter(_ m: [[Bool]]) -> CGPoint {
    var minX = Int.max, maxX = Int.min, minY = Int.max, maxY = Int.min
    for (y, row) in m.enumerated() { for (x, on) in row.enumerated() where on { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } }
    return CGPoint(x: Double(minX + maxX + 1) / 2, y: Double(minY + maxY + 1) / 2)
}

@Suite("Shield logo geometry")
struct LogoTests {
    // Shield rect at the logo's real aspect ratio, large enough for sub-percent precision.
    let w = 820, h = 1000

    @Test("visualCenter is the measured centroid of the shield outline")
    func visualCenterMatchesPath() {
        let rect = CGRect(x: 0, y: 0, width: w, height: h)
        let shield = mask(width: w, height: h) { $0.addPath(ShieldShape().path(in: rect).cgPath); $0.fillPath() }
        let c = centroid(shield)
        #expect(abs(c.x / Double(w) - ShieldShape.visualCenter.x) < 0.003)
        #expect(abs(c.y / Double(h) - ShieldShape.visualCenter.y) < 0.003)
    }

    @Test("tick (as stroked) is centred on the shield's visual centre", arguments: [3.0, 3.5, 44.0 * 1000 / 560])
    func tickCentred(lineWidth: Double) {
        let rect = CGRect(x: 0, y: 0, width: w, height: h)
        let tick = mask(width: w, height: h) { ctx in
            ctx.addPath(ShieldCheckShape().path(in: rect).cgPath)
            ctx.setLineWidth(lineWidth); ctx.setLineCap(.round); ctx.setLineJoin(.round)
            ctx.strokePath()
        }
        let c = boundingBoxCenter(tick)
        // Horizontal: within 0.5 % of the shield width (old tick was +11.6 %). Vertical: 0.5 %.
        #expect(abs(c.x / Double(w) - ShieldShape.visualCenter.x) < 0.005)
        #expect(abs(c.y / Double(h) - ShieldShape.visualCenter.y) < 0.005)
    }

    @Test("tick keeps its original size (only its position changed)")
    func tickSizeUnchanged() {
        let xs = ShieldCheckShape.points.map(\.x), ys = ShieldCheckShape.points.map(\.y)
        // Old tick: 0.35 × 0.25 of the logo height; the shield rect is 0.82 × the height wide.
        #expect(abs((xs.max()! - xs.min()!) * ShieldMark.aspectRatio - 0.35) < 0.002)
        #expect(abs((ys.max()! - ys.min()!) - 0.25) < 0.002)
    }
}

@Suite("Scanner window dragging")
struct WindowDragTests {
    @Test("drag handle doesn't need keyboard focus and accepts the first click")
    @MainActor func dragHandleFlags() {
        let v = WindowDragView()
        #expect(!v.needsPanelToBecomeKey)
        #expect(v.acceptsFirstMouse(for: nil))
    }

    @Test("down → dragged → up moves the actual window origin by the pointer delta")
    @MainActor func dragMovesRealWindow() throws {
        let w = NSPanel(contentRect: NSRect(x: 300, y: 200, width: 420, height: 580), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        let v = WindowDragView(frame: NSRect(x: 0, y: 536, width: 420, height: 44))
        w.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 580))
        w.contentView!.addSubview(v)
        var pointer = NSPoint(x: 400, y: 760)
        WindowDragView.pointerLocation = { pointer }
        defer { WindowDragView.pointerLocation = { NSEvent.mouseLocation } }
        var ended: (NSPoint, NSPoint)?
        WindowDragView.onDragEnded = { ended = ($0, $1) }
        defer { WindowDragView.onDragEnded = nil }
        let e = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 100, y: 560), modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))

        v.mouseDown(with: e)
        pointer = NSPoint(x: 450, y: 700); v.mouseDragged(with: e)
        #expect(w.frame.origin == NSPoint(x: 350, y: 140))
        pointer = NSPoint(x: 100, y: 100); v.mouseDragged(with: e)
        v.mouseUp(with: e)
        #expect(w.frame.origin == NSPoint(x: 0, y: -460))
        #expect(ended?.0 == NSPoint(x: 300, y: 200))
        #expect(ended?.1 == NSPoint(x: 0, y: -460))
        // A stray drag event without a press does nothing.
        pointer = NSPoint(x: 900, y: 900); v.mouseDragged(with: e)
        #expect(w.frame.origin == NSPoint(x: 0, y: -460))
    }

    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
    let second = CGRect(x: 1512, y: 0, width: 1920, height: 1050)
    let size = CGSize(width: 420, height: 580)

    @Test("a user-placed card whose header is on screen is left alone")
    func leftAlone() {
        for origin in [CGPoint(x: 0, y: 0), CGPoint(x: 1000, y: 300), CGPoint(x: 1600, y: 100), CGPoint(x: 1300, y: 300) /* spans both */ ] {
            let f = CGRect(origin: origin, size: size)
            let onOne = [screen, second].contains { $0.contains(CGRect(x: f.minX, y: f.maxY - 44, width: f.width, height: 44)) }
            let result = PanelPlacement.reachableOrigin(for: f, screens: [screen, second], headerHeight: 44)
            #expect((result == nil) == onOne, "origin \(origin)")
        }
        #expect(PanelPlacement.reachableOrigin(for: CGRect(origin: CGPoint(x: 900, y: 200), size: size), screens: [screen, second], headerHeight: 44) == nil)
    }

    @Test("card left on a disconnected display comes back onto a connected one")
    func disconnectedDisplay() {
        let onSecond = CGRect(origin: CGPoint(x: 2600, y: 300), size: size)
        let fixed = PanelPlacement.reachableOrigin(for: onSecond, screens: [screen], headerHeight: 44)
        #expect(fixed != nil)
        #expect(screen.contains(CGRect(origin: fixed!, size: size)))
    }

    @Test("header dragged under the menu bar / off the top edge is pulled back fully on screen")
    func headerOffTop() {
        let f = CGRect(origin: CGPoint(x: 400, y: 500), size: size) // top at 1080 > 944
        let fixed = PanelPlacement.reachableOrigin(for: f, screens: [screen], headerHeight: 44)!
        #expect(fixed == CGPoint(x: 400, y: 944 - 580))
    }
}
