import CoreGraphics
import Foundation
import Vision

/// An in-memory capture. Never written to disk; released as soon as OCR finishes.
public struct CapturedImage: @unchecked Sendable {
    // CGImage is immutable and thread-safe.
    public let cgImage: CGImage
    public let target: CaptureTarget?

    public init(cgImage: CGImage, target: CaptureTarget?) {
        self.cgImage = cgImage
        self.target = target
    }

    public var pixelWidth: Int { cgImage.width }
    public var pixelHeight: Int { cgImage.height }
}

public protocol TextRecognizing: Sendable {
    func recognizeText(in image: CapturedImage) async throws -> OCRResult
}

public enum OCRError: Error, Equatable, Sendable {
    case recognitionFailed
    case imageTooLarge
}

/// On-device OCR with Apple Vision (`VNRecognizeTextRequest`). No network, no cloud OCR.
public struct OCRService: TextRecognizing {
    /// Preferred languages; filtered against what the installed Vision model supports.
    public static let preferredLanguages = ["en-US", "hi-IN"]
    /// Upscale small captures (e.g. a tiny region on a 1× display): Vision's accuracy drops when
    /// glyphs are only a few pixels tall.
    static let upscaleBelowPixels = 500
    /// Refuse absurd inputs (protects memory/CPU).
    static let maxPixels = 60_000_000

    public init() {}

    public static func supportedLanguages(revision: Int = VNRecognizeTextRequestRevision3) -> [String] {
        let request = VNRecognizeTextRequest()
        request.revision = revision
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? []
    }

    public static func recognitionLanguages() -> [String] {
        let supported = Set(supportedLanguages())
        let langs = preferredLanguages.filter(supported.contains)
        return langs.isEmpty ? ["en-US"] : langs
    }

    public func recognizeText(in image: CapturedImage) async throws -> OCRResult {
        guard image.pixelWidth * image.pixelHeight <= Self.maxPixels else { throw OCRError.imageTooLarge }
        let cgImage = image.cgImage
        // Vision is synchronous and CPU-heavy: run it off the main actor.
        return try await Task.detached(priority: .userInitiated) {
            try Self.recognize(cgImage)
        }.value
    }

    static func recognize(_ input: CGImage) throws -> OCRResult {
        let image = upscaledIfSmall(input)
        let request = VNRecognizeTextRequest()
        request.revision = VNRecognizeTextRequestRevision3
        request.recognitionLevel = .accurate
        request.recognitionLanguages = recognitionLanguages()
        // Language correction helps prose, and Vision leaves URL-like tokens intact in practice
        // (covered by tests); our own cleanup never edits URL characters.
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        request.minimumTextHeight = 0

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw OCRError.recognitionFailed
        }
        let observations = (request.results ?? []).compactMap { obs -> TextObservation? in
            guard let top = obs.topCandidates(1).first else { return nil }
            return TextObservation(text: top.string, boundingBox: obs.boundingBox, confidence: Double(top.confidence))
        }
        return TextAssembler.assemble(observations, imageAspect: CGFloat(image.width) / CGFloat(max(1, image.height)))
    }

    /// Vision compiles its text-recognition model the first time a given app binary uses it
    /// (measured ≈ 49 s on an M-series Mac; ≈ 0.1 s afterwards, cached by the OS per binary).
    /// Running one tiny recognition in the background at launch moves that one-time cost out of
    /// the user's first scan. Returns the time it took.
    @discardableResult
    public static func prewarm() async -> Duration {
        let clock = ContinuousClock()
        let start = clock.now
        await Task.detached(priority: .utility) {
            if let image = TextImageRenderer.render("ScamShield", width: 400, height: 120, fontSize: 40) {
                _ = try? recognize(image)
            }
        }.value
        return clock.now - start
    }

    static func upscaledIfSmall(_ image: CGImage) -> CGImage {
        guard min(image.width, image.height) < upscaleBelowPixels, image.width > 0, image.height > 0 else { return image }
        let factor = 2
        let w = image.width * factor, h = image.height * factor
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return image }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage() ?? image
    }
}
