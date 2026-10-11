import Foundation
import ScamShieldCore

/// Developer-only walkthroughs of the scanner states with sample data (Debug mode menu).
public enum PreviewScenario: String, Sendable, CaseIterable {
    case safe, suspicious, critical, serviceDown, permissionRequired, noText

    public var title: String {
        switch self {
        case .safe: return "Safe result"
        case .suspicious: return "Suspicious result"
        case .critical: return "Critical result"
        case .serviceDown: return "Service unavailable"
        case .permissionRequired: return "Permission screen"
        case .noText: return "No text detected"
        }
    }

    public var systemImage: String {
        switch self {
        case .safe: return "checkmark.circle"
        case .suspicious: return "exclamationmark.triangle"
        case .critical: return "exclamationmark.octagon"
        case .serviceDown: return "bolt.horizontal.circle"
        case .permissionRequired: return "lock.circle"
        case .noText: return "text.magnifyingglass"
        }
    }
}
