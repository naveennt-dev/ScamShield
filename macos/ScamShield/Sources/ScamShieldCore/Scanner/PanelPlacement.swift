import CoreGraphics

/// Keeps a user-placed floating window reachable when displays change (pure geometry, AppKit
/// coordinates: origin bottom-left, y up).
public enum PanelPlacement {
    /// nil when the window's drag header (top `headerHeight` points) lies fully on one screen —
    /// leave the window where the user put it. Otherwise the nearest origin that puts the whole
    /// window on the screen it overlaps most (the first screen if it overlaps none).
    public static func reachableOrigin(for frame: CGRect, screens: [CGRect], headerHeight: CGFloat) -> CGPoint? {
        let header = CGRect(x: frame.minX, y: frame.maxY - headerHeight, width: frame.width, height: headerHeight)
        if screens.contains(where: { $0.contains(header) }) { return nil }
        let overlap = { (s: CGRect) -> CGFloat in
            let r = s.intersection(frame)
            return r.isNull ? 0 : r.width * r.height
        }
        guard let first = screens.first else { return nil }
        let target = screens.max(by: { overlap($0) < overlap($1) }).flatMap { overlap($0) > 0 ? $0 : nil } ?? first
        let x = min(max(frame.minX, target.minX), target.maxX - frame.width)
        let y = min(max(frame.minY, target.minY), target.maxY - frame.height)
        return CGPoint(x: x, y: y)
    }
}
