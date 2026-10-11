#if SCAMSHIELD_DEVTOOLS
// Developer tool — compiled only into development builds (SCAMSHIELD_DEVTOOLS=1).
import AppKit
import ScamShieldCore
import ScamShieldDevSupport

/// Developer evaluation of REAL scans (`ScamShield --scan-eval <messages.json> <out-dir>`).
///
/// For each test message it opens a real TextEdit window showing the message, then runs the
/// production scanner twice through `ScannerCoordinator` with production dependencies:
///   1. region scan of exactly that window (real ScreenCaptureKit, Vision OCR, local API);
///   2. full-screen scan of the display (everything visible, as a user's Scan Screen).
/// It records what the result card shows and what History stored for the same scan id, into
/// `<out-dir>/scan-eval.json`. History goes to a throw-away folder (never the user's), and the
/// messages are the repository's synthetic fixtures. Nothing here is reachable from the normal UI.
@MainActor
final class ScanEval {
    private let state: AppState
    private let messagesURL: URL
    private let out: URL

    init(state: AppState, messages: URL, outputDirectory: URL) {
        self.state = state
        self.messagesURL = messages
        self.out = outputDirectory
    }

    struct Message: Decodable { let id: String; let expect: String; let text: String }

    /// Fixed region target for the window being evaluated; full display for the full-screen scan.
    final class Targets: CaptureTargetSelecting {
        var region: CaptureTarget?
        let live = RegionSelectionService()
        func currentDisplayTarget() -> CaptureTarget? { live.currentDisplayTarget() }
        func selectRegion() async -> CaptureTarget? { region }
    }

    func run() {
        Task { @MainActor in
            var results: [[String: Any]] = []
            do {
                let messages = try JSONDecoder().decode([Message].self, from: Data(contentsOf: messagesURL))
                try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                for m in messages {
                    results.append(contentsOf: await evaluate(m))
                }
            } catch {
                results.append(["error": "\(error)"])
            }
            if let data = try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: out.appendingPathComponent("scan-eval.json"))
            }
            NSApp.terminate(nil)
        }
    }

    private func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }

    /// Opens the message in TextEdit and returns that window's frame (CG, top-left origin).
    private func showInTextEdit(_ m: Message) async -> CGRect? {
        let file = out.appendingPathComponent("msg-\(m.id).txt")
        try? m.text.write(to: file, atomically: true, encoding: .utf8)
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        guard let editor = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.TextEdit") else { return nil }
        _ = try? await NSWorkspace.shared.open([file], withApplicationAt: editor, configuration: cfg)
        for _ in 0..<40 {
            await pause(150)
            let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
            if let w = list.first(where: { ($0[kCGWindowOwnerName as String] as? String) == "TextEdit" && (($0[kCGWindowName as String] as? String) ?? "").contains(m.id) }),
               let b = w[kCGWindowBounds as String] as? [String: CGFloat] {
                return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            }
        }
        return nil
    }

    private func evaluate(_ m: Message) async -> [[String: Any]] {
        guard let cgFrame = await showInTextEdit(m), let screen = NSScreen.screens.first(where: { $0.frame.contains(NSPoint(x: cgFrame.midX, y: NSScreen.screens[0].frame.height - cgFrame.midY)) }) ?? NSScreen.main,
              let displayID = screen.displayID else {
            return [["id": m.id, "error": "TextEdit window not found"]]
        }
        await pause(600)
        // CG (top-left) → AppKit global (bottom-left) → display-local, as the region selector does.
        let primaryHeight = NSScreen.screens[0].frame.height
        let appKit = CGRect(x: cgFrame.minX, y: primaryHeight - cgFrame.maxY, width: cgFrame.width, height: cgFrame.height)
        let targets = Targets()
        if let local = CaptureGeometry.displayLocalRect(globalRect: appKit, screenFrame: screen.frame) {
            targets.region = CaptureTarget(kind: .region, displayID: displayID, sourceRect: local, pointPixelScale: screen.backingScaleFactor)
        }

        var rows: [[String: Any]] = []
        for mode in [CaptureMode.region, .fullScreen] {
            var analyzed: (UUID, AnalysisSummary, String)?
            let historyHook = state.coordinator.onAnalyzed
            state.coordinator.onAnalyzed = { id, s, text in
                analyzed = (id, s, text)
                historyHook?(id, s, text)
            }
            state.dependencyOverride = { deps in
                var d = deps
                d.targets = targets
                return d
            }
            // Bring the message window to the front right before capturing (another app may have
            // come forward while the previous scan ran).
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").first?.activate()
            await pause(500)
            state.scan(mode)
            var phase = state.coordinator.phase
            for _ in 0..<600 {
                await pause(50)
                phase = state.coordinator.phase
                if phase.isResult { break }
            }
            state.coordinator.onAnalyzed = historyHook
            state.dependencyOverride = nil

            var row: [String: Any] = ["id": m.id, "expect": m.expect, "mode": mode == .region ? "region" : "full-screen",
                                      "windowFrame": "\(cgFrame)"]
            switch phase {
            case .safe(let p), .suspicious(let p):
                row["card"] = ["tone": p.tone.rawValue, "headline": p.headline, "score": p.riskScore as Any, "category": p.categoryLabel as Any, "reasons": p.reasons, "source": p.source as Any]
            case .failed(let f):
                row["card"] = ["failure": f.title, "message": f.message]
            default:
                row["card"] = ["phase": "\(phase)"]
            }
            if let (scanID, summary, text) = analyzed {
                row["scanID"] = scanID.uuidString
                row["ocrChars"] = text.count
                row["ocrText"] = text // synthetic fixture text only (this tool never scans user data on purpose)
                // Was the test message actually on screen? Distinguishes a disturbed run (window
                // hidden / another app in front) from a detection miss.
                let words = Set(m.text.lowercased().split(whereSeparator: { !$0.isLetter }).filter { $0.count > 3 }.map(String.init))
                let seen = Set(text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init))
                let coverage = words.isEmpty ? 0 : Double(words.intersection(seen).count) / Double(words.count)
                row["messageVisible"] = coverage >= 0.6
                row["messageWordCoverage"] = (coverage * 100).rounded() / 100
                row["engine"] = ["riskLevel": summary.riskLevel.rawValue, "score": summary.riskScore, "category": summary.category, "reasons": summary.reasons]
                if let h = state.history.entries.first(where: { $0.scanID == scanID }) {
                    row["history"] = ["riskLevel": h.riskLevel?.rawValue as Any, "score": h.riskScore as Any, "reasons": h.reasons, "captureMode": h.captureMode?.rawValue as Any,
                                      "matchesCard": h.riskLevel == summary.riskLevel && h.riskScore == summary.riskScore]
                } else {
                    row["history"] = "missing"
                }
            }
            rows.append(row)
            state.closeScanner(reason: "scan-eval")
            await pause(400)
        }
        return rows
    }
}
#endif
