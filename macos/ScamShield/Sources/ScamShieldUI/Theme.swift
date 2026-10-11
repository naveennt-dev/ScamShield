import SwiftUI
import ScamShieldCore

enum Theme {
    static let brand = Color(red: 0.16, green: 0.45, blue: 0.95)

    static func color(for tone: ResultPresentation.Tone) -> Color {
        switch tone {
        case .safe: return Color(red: 0.13, green: 0.68, blue: 0.42)
        case .caution: return Color(red: 0.96, green: 0.62, blue: 0.07)
        case .danger: return Color(red: 0.90, green: 0.20, blue: 0.20)
        }
    }
}
