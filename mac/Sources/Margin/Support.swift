// Small shared pieces: errors shown to the author, alerts, link classification, and two
// thread-safe helpers for reading a child process's output.
import AppKit
import Foundation

/// An error the author sees in an alert: `title` is the alert's headline, `message` its text.
struct AppError: LocalizedError {
    let title: String
    let message: String
    var errorDescription: String? { message }
}

/// Writes one line to stdout right away (unbuffered), for the smoke test and for people who start
/// the app from a terminal.
func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

@MainActor
enum Alerts {
    /// A modal alert; returns the button pressed. In the smoke test nothing may wait for a person,
    /// so the alert is printed and its first button is taken.
    @discardableResult
    static func show(_ title: String, _ message: String, style: NSAlert.Style = .warning, buttons: [String] = ["OK"]) -> NSApplication.ModalResponse {
        if SmokeTest.isActive {
            say("ALERT \(title): \(message.replacingOccurrences(of: "\n", with: " | "))")
            return .alertFirstButtonReturn
        }
        let alert = NSAlert()
        alert.alertStyle = style
        alert.messageText = title
        alert.informativeText = message
        for b in buttons { alert.addButton(withTitle: b) }
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal()
    }

    /// The same as a sheet on `window`, awaited: no nested run loop, so it is safe from a Task (a
    /// modal alert there would hold up every other main-queue block until it is answered). Without
    /// a visible window free for a sheet, a modal alert after all.
    @discardableResult
    static func sheet(_ title: String, _ message: String, style: NSAlert.Style = .warning, on window: NSWindow?, buttons: [String] = ["OK"]) async -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.alertStyle = style
        alert.messageText = title
        alert.informativeText = message
        for b in buttons { alert.addButton(withTitle: b) }
        return await sheet(alert, on: window)
    }

    @discardableResult
    static func sheet(_ alert: NSAlert, on window: NSWindow?) async -> NSApplication.ModalResponse {
        if SmokeTest.isActive {
            say("ALERT \(alert.messageText): \(alert.informativeText.replacingOccurrences(of: "\n", with: " | "))")
            return .alertFirstButtonReturn
        }
        NSApp.activate(ignoringOtherApps: true)
        guard let window, window.isVisible, window.attachedSheet == nil else { return alert.runModal() }
        window.makeKeyAndOrderFront(nil)
        return await withCheckedContinuation { (c: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            alert.beginSheetModal(for: window) { response in c.resume(returning: response) }
        }
    }
}

enum LinkKind {
    case local     // http to 127.0.0.1, localhost or [::1]: the hub and the papers, shown in the app
    case inPage    // about:, blob:, data: (window.open(''), pdf.js internals)
    case external  // http(s) elsewhere, mailto: opened in the default browser or mail app
    case blocked   // anything else (file:, javascript:, custom schemes): never followed
}

enum Links {
    static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]

    static func isLoopback(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased() else { return false }
        return loopbackHosts.contains(host)
    }

    static func kind(of url: URL) -> LinkKind {
        let scheme = url.scheme?.lowercased() ?? ""
        switch scheme {
        case "about", "blob", "data": return .inPage
        case "http": return isLoopback(url) ? .local : .external
        case "https", "mailto": return .external
        default: return .blocked
        }
    }
}

/// A value delivered once, from any thread, to one awaiting task. Later deliveries are ignored, so
/// "ready", "exited" and "timed out" can race and the first one wins.
final class OneShot<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?
    private var waiter: CheckedContinuation<T, Never>?

    func fulfill(_ v: T) {
        lock.lock()
        if value != nil { lock.unlock(); return }
        value = v
        let w = waiter
        waiter = nil
        lock.unlock()
        w?.resume(returning: v)
    }

    func wait() async -> T {
        await withCheckedContinuation { (c: CheckedContinuation<T, Never>) in
            lock.lock()
            if let v = value {
                lock.unlock()
                c.resume(returning: v)
                return
            }
            waiter = c
            lock.unlock()
        }
    }
}

/// Splits bytes arriving on a pipe (on a background thread) into lines.
final class LineSplitter: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private let onLine: @Sendable (String) -> Void

    init(_ onLine: @escaping @Sendable (String) -> Void) { self.onLine = onLine }

    func feed(_ data: Data) {
        lock.lock()
        buffer.append(data)
        var lines: [String] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            lines.append(String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        lock.unlock()
        for l in lines { onLine(l.hasSuffix("\r") ? String(l.dropLast()) : l) }
    }

    func finish() {
        lock.lock()
        let rest = buffer
        buffer = Data()
        lock.unlock()
        if !rest.isEmpty { onLine(String(decoding: rest, as: UTF8.self)) }
    }
}
