// swift-tools-version:5.9
// The Mac app: a small native shell (AppKit + WKWebView) around `margin hub`. No dependencies
// beyond the system frameworks. Build the .app with mac/build-app.sh, not with `swift build` alone
// (the executable needs the Margin sources in its bundle's Resources).
import PackageDescription

let package = Package(
    name: "Margin",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Margin",
            path: "Sources/Margin",
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit")]
        ),
    ]
)
