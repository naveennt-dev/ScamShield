import Foundation

/// Chooses what to capture. Implemented in the app with AppKit (screens, overlay windows).
@MainActor
public protocol CaptureTargetSelecting: AnyObject {
    /// The whole display the user is looking at (the one under the pointer).
    func currentDisplayTarget() -> CaptureTarget?
    /// Shows the region-selection overlay; returns nil if the user cancels (Esc).
    func selectRegion() async -> CaptureTarget?
}
