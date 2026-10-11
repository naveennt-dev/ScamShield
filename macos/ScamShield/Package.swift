// swift-tools-version: 6.0
//
// ScamShield for macOS — Phase 1 (menu-bar foundation).
//
// Built with Swift Package Manager so it compiles with the Command Line Tools alone (no Xcode
// project required). `scripts/build-app.sh` wraps the executable into a proper ScamShield.app
// bundle (menu-bar only, LSUIElement) using Info.plist from this directory.
import Foundation
import PackageDescription

/// Development builds (self-test, scan evaluation, sample previews) set SCAMSHIELD_DEVTOOLS=1
/// (macos/scripts/build-app.sh CONFIG=development, test.sh). Production builds contain none of it.
let devTools = ProcessInfo.processInfo.environment["SCAMSHIELD_DEVTOOLS"] == "1"

/// The SDK the app is built with (macos/scripts/build-app.sh passes `xcrun --show-sdk-version`).
/// With the Command Line Tools, the final link otherwise records the deployment target (14.0) as
/// the SDK version, and macOS then shows the app's system controls (menu popover, settings) in
/// the old compatibility design on macOS 26+. Only a plain version number is accepted.
let sdkVersion = ProcessInfo.processInfo.environment["SCAMSHIELD_SDK_VERSION"].flatMap {
    $0.range(of: #"^[0-9]+(\.[0-9]+){0,2}$"#, options: .regularExpression) != nil ? $0 : nil
}
let sdkLinkerSettings: [LinkerSetting] = sdkVersion.map {
    [.unsafeFlags(["-Xlinker", "-platform_version", "-Xlinker", "macos", "-Xlinker", "14.0", "-Xlinker", $0])]
} ?? []

let package = Package(
    name: "ScamShield",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ScamShield", targets: ["ScamShield"]),
        .executable(name: "ScamShieldSnapshots", targets: ["ScamShieldSnapshots"]),
    ],
    targets: [
        // Pure logic: models, configuration, API client, scanner state machine, hotkey model.
        .target(name: "ScamShieldCore"),
        // SwiftUI views shared by the app and the snapshot tool.
        .target(name: "ScamShieldUI", dependencies: ["ScamShieldCore"]),
        // The menu-bar application (AppKit glue, windows, global hotkey).
        .executableTarget(
            name: "ScamShield",
            dependencies: ["ScamShieldCore", "ScamShieldUI"] + (devTools ? ["ScamShieldDevSupport"] : []),
            swiftSettings: devTools ? [.define("SCAMSHIELD_DEVTOOLS")] : [],
            linkerSettings: sdkLinkerSettings
        ),
        // Developer-only: deterministic sample data and fakes for previews, snapshots and tests.
        .target(name: "ScamShieldDevSupport", dependencies: ["ScamShieldCore"]),
        // Developer tool: renders every UI state to PNG for visual review without screen access.
        .executableTarget(name: "ScamShieldSnapshots", dependencies: ["ScamShieldCore", "ScamShieldUI", "ScamShieldDevSupport"]),
        .testTarget(name: "ScamShieldCoreTests", dependencies: ["ScamShieldCore", "ScamShieldDevSupport"], exclude: ["Fixtures"]),
        .testTarget(name: "ScamShieldUITests", dependencies: ["ScamShieldCore", "ScamShieldUI"]),
    ]
)
