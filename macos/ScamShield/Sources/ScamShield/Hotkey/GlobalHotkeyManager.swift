import Carbon.HIToolbox
import Foundation
import ScamShieldCore

enum HotkeyError: Error, LocalizedError {
    case alreadyInUse(String)
    case registrationFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .alreadyInUse(let s): return "\(s) is already used by another app. Choose a different shortcut."
        case .registrationFailed(let status): return "Couldn't register the shortcut (error \(status))."
        }
    }
}

/// System-wide hotkey via Carbon `RegisterEventHotKey`.
///
/// This is Apple's supported API for app-level global shortcuts: it delivers only the registered
/// key combination to ScamShield, needs NO Accessibility/Input Monitoring permission, and does
/// not observe any other keystrokes (unlike event taps / keyloggers, which we deliberately avoid).
@MainActor
final class GlobalHotkeyManager {
    var onTrigger: (() -> Void)?

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private static let signature: OSType = 0x5353_4844 // 'SSHD'

    func register(_ shortcut: HotkeyShortcut?) -> Result<Void, HotkeyError> {
        unregister()
        guard let shortcut, shortcut.isValidGlobalShortcut else { return .success(()) }
        installHandlerIfNeeded()

        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: Self.signature, id: 1)
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.carbonModifiers, id, GetApplicationEventTarget(), 0, &ref)
        switch status {
        case noErr:
            hotKeyRef = ref
            return .success(())
        case OSStatus(eventHotKeyExistsErr):
            return .failure(.alreadyInUse(shortcut.displayString))
        default:
            return .failure(.registrationFailed(status))
        }
    }

    func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        hotKeyRef = nil
    }

    private func installHandlerIfNeeded() {
        guard handlerRef == nil else { return }
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var hkID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            guard hkID.signature == GlobalHotkeyManager.signature else { return OSStatus(eventNotHandledErr) }
            let manager = Unmanaged<GlobalHotkeyManager>.fromOpaque(userData).takeUnretainedValue()
            // Carbon delivers application-target events on the main thread.
            MainActor.assumeIsolated { manager.onTrigger?() }
            return noErr
        }, 1, &eventType, context, &handlerRef)
    }
}
