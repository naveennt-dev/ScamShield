import CoreGraphics
import Foundation

public enum ScreenCapturePermissionStatus: Sendable, Equatable {
    case granted
    /// Never requested by ScamShield: requesting will show the one-time system prompt.
    case notRequested
    /// The system prompt was just shown; the user decides in the prompt / System Settings.
    case promptShown
    /// Requested before (or denied/revoked): only System Settings can change it.
    case denied
}

@MainActor
public protocol ScreenCapturePermissionProviding: AnyObject {
    func status() -> ScreenCapturePermissionStatus
    /// Shows the system prompt at most once per install; returns the status afterwards.
    func request() -> ScreenCapturePermissionStatus
}

/// Screen Recording (TCC) permission via the public CoreGraphics API.
/// `CGPreflightScreenCaptureAccess` checks without prompting; `CGRequestScreenCaptureAccess`
/// triggers the system prompt only the first time. We remember that we asked, so ScamShield
/// never nags: afterwards the user is pointed to System Settings instead.
@MainActor
public final class ScreenCapturePermission: ScreenCapturePermissionProviding {
    static let askedKey = "screenCapturePermissionRequested"
    private let defaults: UserDefaults
    private let preflight: () -> Bool
    private let requestAccess: () -> Bool

    public init(
        defaults: UserDefaults = .standard,
        preflight: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
        requestAccess: @escaping () -> Bool = { CGRequestScreenCaptureAccess() }
    ) {
        self.defaults = defaults
        self.preflight = preflight
        self.requestAccess = requestAccess
    }

    public func status() -> ScreenCapturePermissionStatus {
        if preflight() { return .granted }
        return defaults.bool(forKey: Self.askedKey) ? .denied : .notRequested
    }

    public func request() -> ScreenCapturePermissionStatus {
        if preflight() { return .granted }
        guard !defaults.bool(forKey: Self.askedKey) else { return .denied }
        defaults.set(true, forKey: Self.askedKey)
        return requestAccess() ? .granted : .promptShown
    }

    /// Privacy & Security › Screen & System Audio Recording.
    public static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
}
