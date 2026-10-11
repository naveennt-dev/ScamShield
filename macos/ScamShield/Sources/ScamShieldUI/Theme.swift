import SwiftUI
import ScamShieldCore

enum Theme {
    static let brand = Color(red: 0.16, green: 0.45, blue: 0.95)
    /// Menu-row highlight on macOS 26+: white text on it measures above WCAG AA (the lighter brand
    /// colour measured 4.36:1, tinted glass 3.1–4.1:1 in real captures).
    static let menuHighlight = Color(red: 0.10, green: 0.36, blue: 0.85)

    static func color(for tone: ResultPresentation.Tone) -> Color {
        switch tone {
        case .safe: return Color(red: 0.13, green: 0.68, blue: 0.42)
        case .caution: return Color(red: 0.96, green: 0.62, blue: 0.07)
        case .danger: return Color(red: 0.90, green: 0.20, blue: 0.20)
        }
    }

    /// Secondary text on the scanner card. On glass (26+) the system `.secondary` measured below
    /// WCAG AA for small captions over busy backgrounds, so a stronger primary tint is used there.
    static var secondaryText: AnyShapeStyle {
        GlassSupport.isAvailable ? AnyShapeStyle(.primary.opacity(0.78)) : AnyShapeStyle(.secondary)
    }

    /// Tone colour for TEXT on the glass card (macOS 26+): darker in light mode, lighter in dark mode
    /// so headline / score keep WCAG contrast over any background (measured on real captures).
    /// Icons and fills keep `color(for:)`; macOS 14–25 keeps `color(for:)` everywhere.
    static func textColor(for tone: ResultPresentation.Tone, scheme: ColorScheme) -> Color {
        guard GlassSupport.isAvailable else { return color(for: tone) }
        switch (tone, scheme) {
        case (.safe, .dark): return Color(red: 0.45, green: 0.88, blue: 0.62)
        case (.safe, _): return Color(red: 0.05, green: 0.48, blue: 0.27)
        case (.caution, .dark): return Color(red: 1.00, green: 0.72, blue: 0.25)
        case (.caution, _): return Color(red: 0.50, green: 0.27, blue: 0.00)
        case (.danger, .dark): return Color(red: 1.00, green: 0.45, blue: 0.42)
        case (.danger, _): return Color(red: 0.76, green: 0.11, blue: 0.11)
        }
    }
}
