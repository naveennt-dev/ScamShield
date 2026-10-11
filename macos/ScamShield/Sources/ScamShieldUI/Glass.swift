import AppKit
import SwiftUI

/// Liquid Glass on macOS 26 and later; the existing materials and button styles on macOS 14–25.
/// Every glass API is behind `#available(macOS 26, *)`, so older systems never call it.
/// "Reduce transparency" and "Increase contrast" are honoured by the system for both paths.
public enum GlassSupport {
    public static var isAvailable: Bool {
        if #available(macOS 26, *) { return true }
        return false
    }
}

extension View {
    /// Strength of the readability tint on the scanner card's glass (chosen from real captures).
    static var cardTintOpacity: Double { 0.9 }

    /// Background of a floating card: Liquid Glass (26+) or `.regularMaterial` with the hairline
    /// border used before (14–25). Clipped to the same continuous rounded rectangle either way.
    @ViewBuilder
    func cardSurface(cornerRadius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(macOS 26, *) {
            // Plain `.regular` glass let busy backgrounds wash out the warning text in real captures
            // (red headline / score, small links); a window-background tint keeps the glass edge
            // and blur but gives the text a dense, readable surface in light and dark mode.
            self.glassEffect(.regular.tint(Color(nsColor: .windowBackgroundColor).opacity(Self.cardTintOpacity)), in: shape)
        } else {
            self.background(.regularMaterial)
                .clipShape(shape)
                .overlay(shape.strokeBorder(.white.opacity(0.08)))
        }
    }

    /// The card's main action (Done / Dismiss / Open System Settings).
    @ViewBuilder
    func primaryActionStyle() -> some View {
        if #available(macOS 26, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self
        }
    }

    /// Secondary actions (Close / Try Again).
    @ViewBuilder
    func secondaryActionStyle() -> some View {
        if #available(macOS 26, *) {
            self.buttonStyle(.glass)
        } else {
            self
        }
    }

    /// Highlighted menu row (white text): a solid highlight in both cases — the slightly darker
    /// `menuHighlight` on 26+ (contrast measured on the glass popover), the brand colour on 14–25.
    @ViewBuilder
    func menuRowHighlight(_ on: Bool) -> some View {
        if #available(macOS 26, *) {
            self.background(on ? Theme.menuHighlight : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            self.background(on ? Theme.brand : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    /// Readability backing for the menu-bar popover's content on macOS 26+. The popover itself is
    /// the system's Liquid Glass (clear, refractive); over bright backgrounds its labels measured
    /// 2.5–2.8:1, so the content sits on a window-coloured layer while the glass edge stays visible.
    @ViewBuilder
    func menuReadabilityBacking() -> some View {
        if #available(macOS 26, *) {
            self.background(Color(nsColor: .windowBackgroundColor).opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(4)
        } else {
            self
        }
    }
}
