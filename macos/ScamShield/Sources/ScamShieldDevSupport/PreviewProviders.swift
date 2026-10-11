import CoreGraphics
import Foundation
import ScamShieldCore

/// Developer previews: walk the real coordinator through every state with sample data.
/// Nothing is read from the screen. Results are labelled "PREVIEW · SAMPLE DATA".
@MainActor
public final class PreviewPermission: ScreenCapturePermissionProviding {
    public var current: ScreenCapturePermissionStatus
    public init(_ status: ScreenCapturePermissionStatus = .granted) { current = status }
    public func status() -> ScreenCapturePermissionStatus { current }
    public func request() -> ScreenCapturePermissionStatus { current == .notRequested ? .promptShown : current }
}

public struct PreviewCapture: ScreenCapturing {
    public init() {}
    public func capture(_ target: CaptureTarget) async throws -> CapturedImage {
        let ctx = CGContext(data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return CapturedImage(cgImage: ctx.makeImage()!, target: target)
    }
}

public struct PreviewRecognizer: TextRecognizing {
    public init() {}
    public func recognizeText(in image: CapturedImage) async throws -> OCRResult {
        let text = "Preview sample text — nothing was read from your screen."
        return OCRResult(text: text, observations: [TextObservation(text: text, boundingBox: CGRect(x: 0, y: 0, width: 1, height: 0.1), confidence: 1)], confidence: 1)
    }
}
