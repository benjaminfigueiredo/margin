// One-click split screen: the paper's window on the top of its screen, and Terminal running
// `claude` in the paper folder as a strip along the bottom (the page's "Claude terminal" button
// posts { type: 'splitWithClaude' }, see PageMessages.swift).
//
// - The rects are a pure function of the screen's visibleFrame (SplitLayout, checked by the smoke
//   test). Terminal takes terminalFraction of the height, at least minTerminalHeight (about eight
//   rows of Terminal's default font plus its title bar) and at most maxTerminalFraction.
// - Terminal is driven by /usr/bin/osascript with a constant script; the folder, the remembered
//   window id and the bounds are arguments of its run handler (argv), never part of the script
//   text, and the folder reaches the shell through AppleScript's `quoted form of`. This is the same
//   pattern as server/macos.js. osascript, rather than NSAppleScript in this process, because the
//   first run waits for the author to answer macOS's Automation prompt: in a child process that
//   wait happens off the main thread (no beach ball, no nested run loop), and the prompt still
//   names Margin, the responsible app.
// - The Terminal window's id is remembered per paper (for the life of the app): pressing again
//   re-arranges that window; if it was closed, a new one is opened.
import AppKit

enum SplitLayout {
    static let terminalFraction: CGFloat = 0.22
    static let minTerminalHeight: CGFloat = 180
    static let maxTerminalFraction: CGFloat = 0.45

    /// Both rects in AppKit's coordinates (origin at the bottom left of the primary display, y up),
    /// filling `visibleFrame` (the screen without the menu bar and the Dock) with no gap.
    static func rects(in visibleFrame: NSRect) -> (editor: NSRect, terminal: NSRect) {
        let v = visibleFrame.integral
        let h = min(max((v.height * terminalFraction).rounded(), minTerminalHeight), (v.height * maxTerminalFraction).rounded())
        let terminal = NSRect(x: v.minX, y: v.minY, width: v.width, height: h)
        let editor = NSRect(x: v.minX, y: v.minY + h, width: v.width, height: v.height - h)
        return (editor, terminal)
    }

    /// AppleScript's `bounds` {left, top, right, bottom}: origin at the top left of the primary
    /// display (the one with the menu bar, NSScreen.screens[0]), y down; other displays have
    /// negative or larger coordinates in the same space.
    static func appleScriptBounds(of r: NSRect, primaryScreenFrame primary: NSRect) -> [Int] {
        [Int(r.minX.rounded()), Int((primary.maxY - r.maxY).rounded()), Int(r.maxX.rounded()), Int((primary.maxY - r.minY).rounded())]
    }
}

/// Opens or re-arranges a paper's Claude Terminal window.
@MainActor
final class ClaudeTerminal {
    struct Request: Equatable {
        let folder: String
        let windowID: Int // 0: none remembered
        let bounds: [Int]
    }

    enum Outcome {
        case done
        case notAllowed // the author said no to Automation for Terminal (or it was turned off)
        case failed(String)
    }

    private let smoke: Bool
    private var windowIDs: [Int: Int] = [:] // paper port → Terminal window id
    private var busy: Set<Int> = []
    private(set) var recorded: [Request] = [] // smoke test: osascript is never run there

    init(smoke: Bool) { self.smoke = smoke }

    func open(paperPort port: Int, folder: String, bounds: [Int]) async -> Outcome {
        guard !busy.contains(port) else { return .done } // a second click while the first runs
        busy.insert(port)
        defer { busy.remove(port) }
        let request = Request(folder: folder, windowID: windowIDs[port] ?? 0, bounds: bounds)
        if smoke {
            recorded.append(request)
            say("TERMINAL would \(request.windowID == 0 ? "open a window" : "re-arrange window \(request.windowID)") in \(folder) at \(bounds)")
            windowIDs[port] = 9000 + recorded.count
            return .done
        }
        let r = await TerminalScript.run([request.folder, String(request.windowID)] + request.bounds.map(String.init))
        if r.status == 0, let id = Int(r.out.trimmingCharacters(in: .whitespacesAndNewlines)) {
            windowIDs[port] = id
            return .done
        }
        // errAEEventNotPermitted (-1743): Automation for Terminal was refused. -1744: it would have
        // to ask, and could not.
        if r.err.contains("-1743") || r.err.contains("-1744") { return .notAllowed }
        let why = r.err.trimmingCharacters(in: .whitespacesAndNewlines)
        return .failed(why.isEmpty ? "osascript exited with status \(r.status)." : why)
    }
}

/// The AppleScript and the osascript child process. Not on the main actor: it runs on a background
/// queue and only hands its result back.
enum TerminalScript {
    static let lines = [
        "on run argv",
        "set folderPath to item 1 of argv",
        "set knownID to (item 2 of argv) as integer",
        "set newBounds to {(item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer, (item 6 of argv) as integer}",
        "set wasRunning to application \"Terminal\" is running",
        "tell application \"Terminal\"",
        "set w to missing value",
        "if knownID > 0 then",
        "try",
        "set w to window id knownID",
        "get name of w",
        "on error",
        "set w to missing value",
        "end try",
        "end if",
        "if w is missing value then",
        "set cmd to \"cd \" & quoted form of folderPath & \" && claude\"",
        "set t to missing value",
        // Just launched: use the window Terminal opens by itself rather than a second one.
        "if not wasRunning then",
        "try",
        "set t to do script cmd in window 1",
        "end try",
        "end if",
        "if t is missing value then set t to do script cmd",
        "repeat with candidate in windows",
        "try",
        "if (tabs of candidate) contains t then set w to contents of candidate",
        "end try",
        "end repeat",
        "if w is missing value then set w to front window",
        "end if",
        "try",
        "set miniaturized of w to false",
        "end try",
        "set bounds of w to newBounds",
        "set index of w to 1",
        "activate",
        "return id of w",
        "end tell",
        "end run",
    ]

    struct Result: Sendable {
        let status: Int32
        let out: String
        let err: String
    }

    /// `arguments` go to the script's run handler. The first one is an absolute folder path (the
    /// hub only stores realpaths), so osascript never reads it as an option.
    static func run(_ arguments: [String]) async -> Result {
        let script = lines.flatMap { ["-e", $0] }
        return await withCheckedContinuation { (c: CheckedContinuation<Result, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                p.arguments = script + arguments
                let out = Pipe(), err = Pipe()
                p.standardOutput = out
                p.standardError = err
                p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch {
                    c.resume(returning: Result(status: -1, out: "", err: "Could not run osascript: \(error.localizedDescription)"))
                    return
                }
                // The Automation prompt waits for the author; AppleScript itself gives up after
                // two minutes. Never leave the process behind.
                DispatchQueue.global().asyncAfter(deadline: .now() + 180) { if p.isRunning { p.terminate() } }
                let o = out.fileHandleForReading.readDataToEndOfFile()
                let e = err.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                c.resume(returning: Result(status: p.terminationStatus, out: String(decoding: o, as: UTF8.self), err: String(decoding: e, as: UTF8.self)))
            }
        }
    }
}
