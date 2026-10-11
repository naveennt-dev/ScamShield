import AppKit
import SwiftUI

/// Liquid Glass on macOS 26 and later; the existing materials and button styles on macOS 14–25.
///
/// Two guards, both needed:
/// - `#if compiler(>=6.2)` (the Swift in Xcode 26, which ships the macOS 26 SDK): an older Xcode
///   doesn't know the glass symbols at all, and `#available` alone can't stop the compiler from
///   rejecting them — that broke CI on Xcode 16.4. Such builds compile the fallback only.
/// - `#available(macOS 26, *)` at run time, so macOS 14–25 never call the glass APIs.
/// "Reduce transparency" and "Increase contrast" are honoured by the system for both paths.
public enum GlassSupport {
    /// True only when this build contains the glass code AND the system is macOS 26+.
    public static var isAvailable: Bool {
        #if compiler(>=6.2)
        if #available(macOS 26, *) { return true }
        #endif
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
        #if compiler(>=6.2)
        if #available(macOS 26, *) {
            // Plain `.regular` glass let busy backgrounds wash out the warning text in real captures
            // (red headline / score, small links); a window-background tint keeps the glass edge
            // and blur but gives the text a dense, readable surface in light and dark mode.
            self.glassEffect(.regular.tint(Color(nsColor: .windowBackgroundColor).opacity(Self.cardTintOpacity)), in: shape)
        } else {
            self.materialCard(shape)
        }
        #else
        self.materialCard(shape)
        #endif
    }

    /// The card's main action (Done / Dismiss / Open System Settings).
    @ViewBuilder
    func primaryActionStyle() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// Secondary actions (Close / Try Again).
    @ViewBuilder
    func secondaryActionStyle() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26, *) {
            self.buttonStyle(.glass)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// The macOS 14–25 card surface (also used by builds without the macOS 26 SDK).
    private func materialCard(_ shape: RoundedRectangle) -> some View {
        self.background(.regularMaterial)
            .clipShape(shape)
            .overlay(shape.strokeBorder(.white.opacity(0.08)))
    }

    /// Highlighted menu row (white text): a solid highlight in both cases — the slightly darker
    /// `menuHighlight` on 26+ (contrast measured on the glass popover), the brand colour on 14–25.
    @ViewBuilder
    func menuRowHighlight(_ on: Bool) -> some View {
        if GlassSupport.isAvailable {
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
        if GlassSupport.isAvailable {
            self.background(Color(nsColor: .windowBackgroundColor).opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(4)
        } else {
            self
        }
    }
}
