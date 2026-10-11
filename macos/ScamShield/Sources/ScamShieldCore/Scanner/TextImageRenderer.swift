import AppKit
import CoreGraphics

/// Renders text into an in-memory image. Used by tests and the self-test to exercise the real
/// Vision OCR path without touching the screen. Never written to disk.
public enum TextImageRenderer {
    public static func render(
        _ text: String,
        width: Int = 1400,
        height: Int = 700,
        fontSize: CGFloat = 34,
        fontName: String? = nil,
        background: NSColor = .white,
        foreground: NSColor = .black
    ) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(background.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = gc
        let font = fontName.flatMap { NSFont(name: $0, size: fontSize) } ?? NSFont.systemFont(ofSize: fontSize)
        let style = NSMutableParagraphStyle()
        style.lineSpacing = fontSize * 0.25
        let attributed = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: foreground, .paragraphStyle: style])
        let inset = min(40, CGFloat(min(width, height)) * 0.12)
        attributed.draw(in: CGRect(x: inset, y: inset, width: CGFloat(width) - 2 * inset, height: CGFloat(height) - 2 * inset))
        NSGraphicsContext.restoreGraphicsState()
        return ctx.makeImage()
    }
}
