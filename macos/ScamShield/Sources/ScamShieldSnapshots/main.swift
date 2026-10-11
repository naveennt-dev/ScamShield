import AppKit
import SwiftUI
import ScamShieldCore
import ScamShieldDevSupport
import ScamShieldUI

/// Renders every scanner state, the menu and the icon to PNG (offscreen, no screen access).
/// Usage: ScamShieldSnapshots <output-dir> [--icon-only]
@MainActor
func render<V: View>(_ view: V, size: CGSize, scheme: ColorScheme, to url: URL, scale: CGFloat = 2) {
    let content = view
        .frame(width: size.width, height: size.height)
        .background(scheme == .dark ? Color(white: 0.12) : Color(white: 0.96))
        .environment(\.colorScheme, scheme)
    let renderer = ImageRenderer(content: content)
    renderer.scale = scale
    guard let cg = renderer.cgImage else { fatalError("render failed: \(url.lastPathComponent)") }
    let rep = NSBitmapImageRep(cgImage: cg)
    try! rep.representation(using: .png, properties: [:])!.write(to: url)
}

@MainActor
func main() {
    let args = CommandLine.arguments
    let out = URL(fileURLWithPath: args.count > 1 ? args[1] : "snapshots")
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

    // App icon artwork (the shield brand mark) at 1024 px.
    let icon = ZStack {
        RoundedRectangle(cornerRadius: 230, style: .continuous)
            .fill(LinearGradient(colors: [Color(red: 0.12, green: 0.38, blue: 0.92), Color(red: 0.05, green: 0.16, blue: 0.45)], startPoint: .top, endPoint: .bottom))
            .padding(100)
        ShieldMark(lineWidth: 44).foregroundStyle(.white).frame(width: 470, height: 560)
    }
    render(icon, size: CGSize(width: 1024, height: 1024), scheme: .dark, to: out.appendingPathComponent("AppIcon-1024.png"), scale: 1)
    if args.contains("--icon-only") { return }

    // Menu-bar template icon at its real size (18 pt) for 1× and 2× displays.
    for scale in [1, 2] {
        let px = 18 * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = NSSize(width: 18, height: 18)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: 18, height: 18).fill()
        MenuBarIcon.image().draw(in: NSRect(x: 0, y: 0, width: 18, height: 18))
        NSGraphicsContext.restoreGraphicsState()
        try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("menubar-icon@\(scale)x.png"))
    }
    // Every in-app logo size, on white, at 2× (as on a Retina display).
    let marks = HStack(alignment: .center, spacing: 24) {
        ShieldMark(lineWidth: 2).foregroundStyle(.black).frame(width: 22, height: 26)   // menu popover
        ShieldMark(lineWidth: 3.5).foregroundStyle(.black).frame(width: 58, height: 70) // scanning animation
        ShieldMark(lineWidth: 3).foregroundStyle(.black).frame(width: 70, height: 84)   // idle / select / cancelled
    }
    render(marks.padding(16), size: CGSize(width: 250, height: 120), scheme: .light, to: out.appendingPathComponent("logo-sizes@2x.png"))

    let samples = try! [
        ("safe", ScannerPhase.safe(ResultPresentation(summary: MockScamShieldAPI.sample(for: .safe)))),
        ("suspicious", .suspicious(ResultPresentation(summary: MockScamShieldAPI.sample(for: .suspicious)))),
        ("critical", .suspicious(ResultPresentation(summary: MockScamShieldAPI.sample(for: .critical)))),
    ]
    let text = ExtractedTextSummary(lineCount: 5, characterCount: 140, urlCount: 1, confidence: 0.94, wasTruncated: false,
                                    preview: "Dear SBI customer, your KYC has expired.\n\nUpdate immediately:\nhttps://sbi-kyc-update.xyz/verify")
    let phases: [(String, ScannerPhase)] = [
        ("idle", .idle),
        ("capturing", .capturing(.region)),
        ("ocr", .processingOCR),
        ("text-ready", .textReady(text)),
        ("analyzing", .sendingForAnalysis),
    ] + samples + [
        ("permission-required", .failed(.permissionRequired)),
        ("permission-denied", .failed(.permissionDenied)),
        ("no-text", .failed(.noTextDetected)),
        ("ocr-failed", .failed(.ocrFailed)),
        ("capture-failed", .failed(.captureFailed)),
        ("service-down", .failed(.analysisServiceUnavailable)),
        ("cloud-enabled", .failed(.cloudAnalysisEnabled)),
    ]
    for scheme in [ColorScheme.light, .dark] {
        let suffix = scheme == .dark ? "dark" : "light"
        for (name, phase) in phases {
            render(ScannerView(phase: phase, ), size: ScannerView.size, scheme: scheme, to: out.appendingPathComponent("scanner-\(name)-\(suffix).png"))
        }
        let menu = MenuBarView(shortcut: .default, connection: .online(BackendHealth(status: "ok", checks: [:], appVersion: "1.0.0")),
                               actions: .init(scanScreen: {}, selectRegion: {}, openSettings: {}, quit: {}))
        render(menu, size: CGSize(width: 260, height: 500), scheme: scheme, to: out.appendingPathComponent("menu-\(suffix).png"))
    }
    print("Rendered snapshots to \(out.path)")
}

MainActor.assumeIsolated { main() }
