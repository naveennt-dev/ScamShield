import CoreGraphics
import Foundation
import ScreenCaptureKit

public protocol ScreenCapturing: Sendable {
    func capture(_ target: CaptureTarget) async throws -> CapturedImage
}

public enum CaptureError: Error, Equatable, Sendable {
    case permissionDenied
    case displayNotFound
    case invalidRegion
    case failed
}

/// Single-frame capture with ScreenCaptureKit (`SCScreenshotManager`, macOS 14+).
///
/// One call = one frame, in memory only. No stream is started, nothing is recorded, nothing is
/// written to disk. ScamShield's own windows (scanner card, selection overlay) are excluded.
public struct ScreenCaptureService: ScreenCapturing {
    /// Self-tests set this to false to capture a ScamShield-owned test window.
    public var excludeOwnApp: Bool

    public init(excludeOwnApp: Bool = true) {
        self.excludeOwnApp = excludeOwnApp
    }

    public func capture(_ target: CaptureTarget) async throws -> CapturedImage {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw Self.map(error)
        }
        guard let display = content.displays.first(where: { $0.displayID == target.displayID }) else {
            throw CaptureError.displayNotFound
        }
        let pid = ProcessInfo.processInfo.processIdentifier
        let excluded = excludeOwnApp ? content.applications.filter { $0.processID == pid } : []
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])

        // Prefer ScreenCaptureKit's own point→pixel scale for this display (correct for scaled
        // "looks like" resolutions); fall back to the scale the caller computed.
        let scale = CGFloat(filter.pointPixelScale) > 0 ? CGFloat(filter.pointPixelScale) : target.pointPixelScale
        let displaySize = CGSize(width: display.width, height: display.height)
        guard let rect = CaptureGeometry.normalized(target.sourceRect, displaySize: displaySize, scale: scale) else {
            throw CaptureError.invalidRegion
        }
        let pixels = CaptureGeometry.pixelSize(of: rect, scale: scale)

        let config = SCStreamConfiguration()
        config.sourceRect = rect
        config.width = max(1, Int(pixels.width))
        config.height = max(1, Int(pixels.height))
        config.showsCursor = false
        config.capturesAudio = false
        config.scalesToFit = false

        do {
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            return CapturedImage(cgImage: image, target: target)
        } catch {
            throw Self.map(error)
        }
    }

    static func map(_ error: Error) -> CaptureError {
        let ns = error as NSError
        if ns.domain == SCStreamErrorDomain, ns.code == SCStreamError.userDeclined.rawValue {
            return .permissionDenied
        }
        return .failed
    }
}
