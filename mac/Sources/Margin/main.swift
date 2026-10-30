// Margin.app entry point. The app is a window onto `margin hub` (bin/margin.js), which it starts
// with the Node.js installed on the Mac and stops on quit. See AppDelegate.swift.
import AppKit

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run() // returns only through exit(): `delegate` lives as long as the app
}
