import CoreGraphics
import Foundation

/// What to capture: a whole display or a rectangle on ONE display.
///
/// Coordinate contract (matches ScreenCaptureKit's `SCStreamConfiguration.sourceRect`):
/// `sourceRect` is in **points**, relative to the display's top-left corner. Pixel dimensions are
/// `sourceRect.size × pointPixelScale`.
public struct CaptureTarget: Sendable, Equatable {
    public enum Kind: String, Sendable { case fullDisplay, region }

    public let kind: Kind
    public let displayID: UInt32
    public let sourceRect: CGRect
    public let pointPixelScale: CGFloat

    public init(kind: Kind, displayID: UInt32, sourceRect: CGRect, pointPixelScale: CGFloat) {
        self.kind = kind
        self.displayID = displayID
        self.sourceRect = sourceRect
        self.pointPixelScale = pointPixelScale
    }

    public var pixelSize: CGSize { CaptureGeometry.pixelSize(of: sourceRect, scale: pointPixelScale) }
}

/// Pure coordinate math for multi-monitor, Retina and scaled displays. AppKit's global coordinate
/// space has its origin at the bottom-left of the primary display (y grows upwards; secondary
/// displays may have negative coordinates). ScreenCaptureKit wants display-local, top-left points.
public enum CaptureGeometry {
    /// Smallest selection (in points) we accept — anything smaller is almost certainly a mis-click.
    public static let minimumSelectionSize = CGSize(width: 12, height: 12)

    /// Rectangle spanned by a drag from `a` to `b`, in any direction.
    public static func rect(from a: CGPoint, to b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    /// Converts a rect in AppKit global coordinates to display-local, top-left points for the
    /// display whose frame (global coordinates) is `screenFrame`. The result is clipped to the display.
    public static func displayLocalRect(globalRect: CGRect, screenFrame: CGRect) -> CGRect? {
        let clipped = globalRect.standardized.intersection(screenFrame)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
        return CGRect(
            x: clipped.minX - screenFrame.minX,
            y: screenFrame.maxY - clipped.maxY,
            width: clipped.width,
            height: clipped.height
        )
    }

    /// Clamps a display-local rect to the display bounds and snaps it outwards to whole device
    /// pixels, so the captured image is exactly what the user framed (no half-pixel blur).
    public static func normalized(_ rect: CGRect, displaySize: CGSize, scale: CGFloat) -> CGRect? {
        guard scale > 0, rect.width.isFinite, rect.height.isFinite, rect.minX.isFinite, rect.minY.isFinite else { return nil }
        let bounds = CGRect(origin: .zero, size: displaySize)
        let clipped = rect.standardized.intersection(bounds)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
        let minX = (clipped.minX * scale).rounded(.down) / scale
        let minY = (clipped.minY * scale).rounded(.down) / scale
        let maxX = (clipped.maxX * scale).rounded(.up) / scale
        let maxY = (clipped.maxY * scale).rounded(.up) / scale
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY).intersection(bounds)
    }

    public static func isValidSelection(_ rect: CGRect) -> Bool {
        rect.width >= minimumSelectionSize.width && rect.height >= minimumSelectionSize.height
    }

    public static func pixelSize(of rect: CGRect, scale: CGFloat) -> CGSize {
        CGSize(width: (rect.width * scale).rounded(), height: (rect.height * scale).rounded())
    }

    /// "1280 × 640 px" label for the selection overlay.
    public static func sizeLabel(for rect: CGRect, scale: CGFloat) -> String {
        let px = pixelSize(of: rect, scale: scale)
        return "\(Int(px.width)) × \(Int(px.height)) px"
    }
}
