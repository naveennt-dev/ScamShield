import SwiftUI

/// One-time choice, shown on first launch: should ScamShield also ask an AI for a second opinion?
public struct ConsentView: View {
    let onChoice: (Bool) -> Void

    public init(onChoice: @escaping (Bool) -> Void) { self.onChoice = onChoice }

    public static let size = CGSize(width: 520, height: 470)

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                ShieldMark(lineWidth: 3).foregroundStyle(Theme.brand).frame(width: 34, height: 40)
                Text("Get an AI second opinion on scans?").font(.title2.weight(.semibold))
            }
            Text("Every scan is always checked on this device first (safety rules, ML model, link checks). With the AI second opinion on, the text of the scan is also checked by an AI model. It catches new kinds of fraud the local checks may miss.")
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 6) {
                Label("Sent: only the text ScamShield read from the area you scanned, with OTPs, card/account/phone numbers, e-mail addresses, UPI IDs and link paths masked.", systemImage: "arrow.up.circle")
                Label("Never sent: screenshots or images, your History, other windows, passwords.", systemImage: "lock.circle")
                Label("The AI can only raise a warning — it can never make a result look safer than the on-device check.", systemImage: "shield.lefthalf.filled")
                Label("The AI service may log what it receives. Choose \u{201C}On this device only\u{201D} for full privacy.", systemImage: "info.circle")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            Text("You can change this any time in Settings → Analysis.").font(.caption).foregroundStyle(.tertiary)
            Spacer(minLength: 0)
            HStack {
                Button("On this device only") { onChoice(false) }.controlSize(.large)
                Spacer()
                Button("Turn on AI second opinion") { onChoice(true) }.keyboardShortcut(.defaultAction).controlSize(.large)
            }
        }
        .padding(24)
        .frame(width: Self.size.width, height: Self.size.height)
    }
}
