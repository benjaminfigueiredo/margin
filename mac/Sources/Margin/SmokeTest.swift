// `Margin --smoke-test` (or MARGIN_SMOKE_TEST=1): the app checks itself, for CI.
//
// It starts its own hub (never attaching to a running one) on port 47242 (MARGIN_HUB_PORT) with a
// temporary config folder, then checks: the Papers page loads and its script runs; if
// MARGIN_SMOKE_PAPER names a paper folder, a copy of it opens in its own window, the editor
// boots and its WebSocket connects, JavaScript dialogs are answered, opening it again focuses
// the same window, the page's messages reach the app (a notification after a Claude Code hook
// event, recorded and never posted; the split-screen button, with Terminal never run), the split
// rects are right for a few screen layouts, and notes "dropped" on the app land in the paper's
// private context; a hub whose stdin closes exits by itself; and quitting through the normal
// quit path stops the hub and the paper. Prints PASS/FAIL lines; exits 0 if everything passed.
// Dialogs and save panels are answered automatically and printed: nothing waits for a person.
import AppKit
import Darwin

@MainActor
final class SmokeTest {
    private(set) static var isActive = false

    let workDir: URL
    private var failures = 0
    private var hubPid: Int32?
    private var paperPid: Int32?

    init() {
        SmokeTest.isActive = true
        workDir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("margin-smoke-\(getpid())", isDirectory: true)
        try? FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        say("Margin smoke test: working in \(workDir.path)")
        SmokeWatchdog.shared.arm(seconds: 300)
    }

    static func dialog(_ kind: String, _ message: String) {
        say("DIALOG \(kind): \(message.replacingOccurrences(of: "\n", with: " | "))")
    }

    // MARK: - the checks

    func run(_ app: AppDelegate) async {
        let hub = app.hub, windows = app.windows
        hubPid = hub.pid
        if let pid = hubPid { SmokeWatchdog.shared.add(pid: pid) }
        say("hub: \(hub.url.absoluteString), pid \(hubPid.map { String($0) } ?? "none"), \(hub.nodeDescription), log \(hub.logURL.path)")
        check(hubPid != nil && !hub.attached, "the app started its own hub")

        step("the Papers window")
        guard let papers = windows.papersWindow else { return giveUp("there is no Papers window") }
        let listReady = "String(document.readyState === 'complete' && !!document.querySelector('#btn-add') && !!document.querySelector('#empty') && !document.querySelector('#empty').classList.contains('hidden'))"
        guard await waitFor(seconds: 60, { await papers.evaluate(listReady) == "true" }) else {
            await describe(papers)
            return giveUp("the Papers page did not load, or its script did not run (if nothing at all answered, WKWebView may not render in this session)")
        }
        pass("the Papers page loaded and its script listed no papers (title “\(papers.window?.title ?? "")”)")

        guard let source = ProcessInfo.processInfo.environment["MARGIN_SMOKE_PAPER"], !source.isEmpty else {
            say("SKIP opening a paper: MARGIN_SMOKE_PAPER is not set")
            await stdinCheck(hub)
            return quit()
        }

        step("adding a paper")
        let paperDir = workDir.appendingPathComponent("sample-paper", isDirectory: true)
        do {
            try? FileManager.default.removeItem(at: paperDir)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: source, isDirectory: true), to: paperDir)
        } catch {
            return giveUp("could not copy \(source): \(error.localizedDescription)")
        }
        await app.addAndOpen(folder: paperDir) // what File → Open Folder… does after its panel
        guard let paper = windows.papers.first else { return giveUp("the hub did not add \(paperDir.path)") }
        pass("the hub added \(paper.name) on port \(paper.port)")

        step("the paper's window")
        var paperWindow: BrowserWindowController?
        let editorReady = "String(!!document.querySelector('#current-file') && document.querySelector('#current-file').textContent !== '' && !!document.querySelector('#conn') && document.querySelector('#conn').classList.contains('on'))"
        let loaded = await waitFor(seconds: 120) {
            guard let w = windows.window(forPaperPort: paper.port), w.webView.url?.port == paper.port else { return false }
            paperWindow = w
            return await w.evaluate(editorReady) == "true"
        }
        guard loaded, let paperWindow else {
            if let w = windows.window(forPaperPort: paper.port) ?? windows.paperWindows.first { await describe(w) }
            say("hub log:\n\(hub.logTail())")
            return giveUp("the paper's window did not show a working editor (file loaded, WebSocket connected)")
        }
        pass("the paper opened in its own window, the editor loaded and its WebSocket connected (title “\(paperWindow.window?.title ?? "")”)")

        let answers = await paperWindow.evaluate("String(confirm('Smoke test: confirm')) + ',' + String(prompt('Smoke test: prompt', 'x'))")
        check(answers == "true,smoke-answer", "confirm() and prompt() reach the app's panels (got \(answers ?? "nothing"))")

        // window.open('') that the page writes into (as Raw log does), then window.close().
        let others = { windows.controllers.filter { $0.kind == .other }.count }
        let opened = await paperWindow.evaluate("(() => { const w = window.open('', '_blank'); if (!w) return 'blocked'; w.document.title = 'Smoke log'; w.document.body.textContent = 'ok'; setTimeout(() => w.close(), 300); return w.document.title; })()")
        check(opened == "Smoke log" && others() == 1, "window.open('') gets a window the page can write into (got \(opened ?? "nothing"), \(others()) window(s))")
        let closedAgain = await waitFor(seconds: 5) { others() == 0 }
        check(closedAgain, "and window.close() from the page closes it")

        windows.openPaper(id: paper.id, port: paper.port)
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        check(windows.paperWindows.count == 1, "opening the paper again brings its window forward instead of a second one (\(windows.paperWindows.count) window(s))")

        splitLayoutChecks()
        await pageMessageChecks(app, paper: paper, window: paperWindow)
        await noteDropChecks(app, paper: paper)

        let running = await windows.refreshPapers()?.first { $0.id == paper.id }
        if let pid = running?.pid {
            paperPid = Int32(pid)
            SmokeWatchdog.shared.add(pid: Int32(pid))
        }
        check(running?.state == "running" && paperPid != nil, "the hub reports the paper running (pid \(paperPid.map { String($0) } ?? "none"))")

        await stdinCheck(hub)
        quit()
    }

    // MARK: - split screen, page messages, notes

    /// The pure part of split screen: rects and AppleScript bounds for a few screen layouts.
    private func splitLayoutChecks() {
        step("split screen: the rects")
        let primary = NSRect(x: 0, y: 0, width: 1920, height: 1200)
        // The primary display with the menu bar (25 pt) and a hidden Dock: Terminal gets 22 %.
        let r = SplitLayout.rects(in: NSRect(x: 0, y: 0, width: 1920, height: 1175))
        check(r.terminal == NSRect(x: 0, y: 0, width: 1920, height: 259) && r.editor == NSRect(x: 0, y: 259, width: 1920, height: 916),
              "editor on top, Terminal a 259 pt strip (22 %) at the bottom, no gap (\(r.editor) / \(r.terminal))")
        let b = SplitLayout.appleScriptBounds(of: r.terminal, primaryScreenFrame: primary)
        check(b == [0, 941, 1920, 1200], "AppleScript bounds count from the top left of the primary display (\(b))")
        // A short screen: at least minTerminalHeight (about eight rows).
        let small = SplitLayout.rects(in: NSRect(x: 0, y: 70, width: 1280, height: 700))
        check(small.terminal == NSRect(x: 0, y: 70, width: 1280, height: SplitLayout.minTerminalHeight) && small.editor.height == 700 - SplitLayout.minTerminalHeight,
              "a short screen still gives Terminal \(Int(SplitLayout.minTerminalHeight)) pt (\(small.terminal))")
        // A second display above the primary one, and one to its left and lower (negative x and y).
        let above = SplitLayout.appleScriptBounds(of: SplitLayout.rects(in: NSRect(x: 200, y: 1200, width: 1920, height: 1055)).terminal, primaryScreenFrame: primary)
        check(above == [200, -232, 2120, 0], "a display above the primary one: negative top, bottom at the primary's top edge (\(above))")
        let left = SplitLayout.appleScriptBounds(of: SplitLayout.rects(in: NSRect(x: -1680, y: -150, width: 1680, height: 1050)).terminal, primaryScreenFrame: primary)
        check(left == [-1680, 1119, 0, 1350], "a display to the left and lower: negative left, bottom below the primary's (\(left))")
    }

    /// A Claude Code hook event on the paper's server reaches the app as a notify message, and the
    /// page's split button reaches the split code (Terminal is never run in the smoke test).
    private func pageMessageChecks(_ app: AppDelegate, paper: Paper, window w: BrowserWindowController) async {
        step("page messages: a notification")
        let notify: [String: Any] = ["type": "notify", "title": " T ", "body": "B", "tag": "claude"]
        let parsed: [Bool] = [
            PageMessage(notify) == PageMessage.notify(title: "T", body: "B", tag: "claude"),
            PageMessage(["type": "splitWithClaude"] as [String: Any]) == PageMessage.splitWithClaude(paperID: nil),
            PageMessage(["type": "splitWithClaude", "paper": "0123456789ab"] as [String: Any]) == PageMessage.splitWithClaude(paperID: "0123456789ab"),
            PageMessage(["type": "splitWithClaude", "paper": "../../etc"] as [String: Any]) == nil,
            PageMessage(["type": "notify"] as [String: Any]) == nil,
            PageMessage(["type": "run", "cmd": "x"] as [String: Any]) == nil,
            PageMessage("notify") == nil,
        ]
        check(!parsed.contains(false), "the page's messages are parsed; unknown or malformed ones are ignored (\(parsed))")
        let before = app.notifier.recorded.count
        let event: [String: Any] = ["event": "Notification", "notification_type": "permission_prompt", "message": "Smoke: Claude needs your permission to use Bash"]
        let status = await postJSON(port: paper.port, path: "api/claude/event", event)
        let arrived = await waitFor(seconds: 20) { app.notifier.recorded.count > before }
        let n = app.notifier.recorded.last
        let title = n?.title ?? "", body = n?.body ?? "", tag = n?.tag ?? "", port = n?.paperPort ?? 0
        let right = title == "Claude needs you — \(paper.name)" && body == "Smoke: Claude needs your permission to use Bash" && tag == "claude" && port == paper.port
        check(status == 200 && arrived && right, "a Notification hook event becomes a notify message from the paper's page (status \(status), got “\(title) | \(body)”, tag \(tag), port \(port))")

        step("page messages: split screen with Claude")
        let clicked = await w.evaluate("(() => { const b = document.querySelector('#btn-split-claude'); if (!b || b.classList.contains('hidden')) return 'hidden'; b.click(); return 'clicked'; })()")
        let split = await waitFor(seconds: 10) { app.terminal.recorded.count == 1 }
        let req = app.terminal.recorded.first
        let resolved = { (p: String) in URL(fileURLWithPath: p).resolvingSymlinksInPath().path }
        let same = req.map { resolved($0.folder) == resolved(paper.path) } ?? false
        let firstID = req?.windowID ?? -1
        check(clicked == "clicked" && split && same && firstID == 0,
              "the page's Claude terminal button asks for Terminal in the paper folder (\(clicked ?? "no answer"); \(req.map { "\($0.folder) \($0.bounds)" } ?? "nothing"))")
        if let window = w.window, let screen = window.screen ?? NSScreen.main, let primary = NSScreen.screens.first {
            let rects = SplitLayout.rects(in: screen.visibleFrame)
            let near = { (a: CGFloat, b: CGFloat) -> Bool in abs(a - b) < 2 }
            _ = await waitFor(seconds: 3) { near(window.frame.minY, rects.editor.minY) }
            let f = window.frame, e = rects.editor
            let close = near(f.minX, e.minX) && near(f.minY, e.minY) && near(f.width, e.width) && near(f.height, e.height)
            check(close, "the paper's window fills the top of its screen (\(f) for \(rects.editor) on \(screen.visibleFrame))")
            check(req?.bounds == SplitLayout.appleScriptBounds(of: rects.terminal, primaryScreenFrame: primary.frame), "and Terminal gets the strip below it (\(req?.bounds ?? []))")
        } else {
            fail("the paper's window has no screen")
        }
        await app.splitWithClaude(w)
        let again = app.terminal.recorded.last
        check(app.terminal.recorded.count == 2 && again?.windowID == 9001, "pressing again re-arranges the same Terminal window (id \(again?.windowID ?? -1)) instead of opening another")
    }

    /// What dropping notes on the Dock icon does (application(_:open:) is skipped in the smoke
    /// test, so its handler is called directly): they land in the paper's private context.
    private func noteDropChecks(_ app: AppDelegate, paper: Paper) async {
        step("notes dropped on the app")
        let dir = workDir.appendingPathComponent("drop", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let good = dir.appendingPathComponent("smoke note + call.md")
        let binary = dir.appendingPathComponent("not text.txt")
        let other = dir.appendingPathComponent("slides.key")
        do {
            try Data("# Smoke note\n\nFrom a call about the paper.\n".utf8).write(to: good)
            try Data([0x61, 0x00, 0x62, 0x00]).write(to: binary)
            try Data("x".utf8).write(to: other)
        } catch {
            return fail("could not write the notes to drop: \(error.localizedDescription)")
        }
        let results = await app.notes.add(notes: [good, binary], others: [other])
        let lines = results.map { r -> String in r.addedAs.map { "\(r.file) → \($0)" } ?? "\(r.file) → not added: \(r.problem ?? "")" }
        say("results: \(lines.joined(separator: "; "))")
        check(results.count == 3 && results[0].addedAs == "smoke note + call.md", "a .md note is added under its own name (spaces and + included)")
        check(results.count == 3 && results[1].addedAs == nil && (results[1].problem ?? "").contains("plain text"), "a .txt that is not text is refused with the paper's own message")
        check(results.count == 3 && results[2].addedAs == nil && (results[2].problem ?? "").contains("not a note"), "a file that is not a note is reported, not sent")
        let listed = await getJSON(port: paper.port, path: "api/context")
        let names = ((listed?["items"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }
        check(names.contains("smoke note + call.md") && !names.contains("not text.txt"), "the paper's GET /api/context lists it (\(names))")
    }

    private func postJSON(port: Int, path: String, _ body: [String: Any]) async -> Int {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/\(path)")!)
        request.httpMethod = "POST"
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let answer = try? await HubClient.session.data(for: request) else { return 0 }
        return (answer.1 as? HTTPURLResponse)?.statusCode ?? 0
    }

    private func getJSON(port: Int, path: String) async -> [String: Any]? {
        guard let answer = try? await HubClient.session.data(from: URL(string: "http://127.0.0.1:\(port)/\(path)")!) else { return nil }
        return (try? JSONSerialization.jsonObject(with: answer.0)) as? [String: Any]
    }

    /// A second hub, to check what happens when the app dies: its stdin closes, and it must exit.
    private func stdinCheck(_ hub: HubController) async {
        step("a hub whose stdin closes")
        let probe = HubController(port: hub.port + 17, resources: hub.resources, logURL: workDir.appendingPathComponent("probe-hub.log"))
        probe.allowAttach = false
        probe.extraEnvironment = ["MARGIN_CONFIG_DIR": workDir.appendingPathComponent("probe-config").path]
        do { try await probe.start() } catch {
            return fail("a second hub did not start: \(error.localizedDescription)")
        }
        if let pid = probe.pid { SmokeWatchdog.shared.add(pid: pid) }
        probe.closeStdin() // what the hub sees when the app crashes or is force-quit
        let gone = await waitFor(seconds: 15) { !probe.isRunning }
        check(gone, "a hub whose stdin closes (the app gone) exits by itself")
        if !gone { await probe.stop() }
    }

    private func quit() {
        step("quitting")
        say("quitting through the normal quit path (⌘Q)")
        AppDelegate.requestQuit()
    }

    /// From applicationWillTerminate, after the normal quit path ran.
    func finish(hub: HubController) {
        if let pid = hubPid {
            check(!hub.isRunning && !Self.exists(pid, wait: 5), "quitting stopped the hub (pid \(pid))")
        }
        if let pid = paperPid {
            check(!Self.exists(pid, wait: 5), "and the paper it ran (pid \(pid))")
        }
        say(failures == 0 ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED: \(failures) check(s) failed")
        if failures == 0 { try? FileManager.default.removeItem(at: workDir) }
        exit(failures == 0 ? 0 : 1)
    }

    /// A failure after which there is no point going on: still quit the normal way, so the hub stops.
    func giveUp(_ message: String) {
        fail(message)
        quit()
    }

    /// The hub never started: nothing to stop.
    func abortLaunch(_ message: String) -> Never {
        fail(message)
        say("SMOKE TEST FAILED")
        exit(1)
    }

    // MARK: - helpers

    private func step(_ name: String) {
        say("-- \(name)")
        SmokeWatchdog.shared.set(step: name)
    }

    private func pass(_ message: String) { say("PASS \(message)") }

    private func fail(_ message: String) {
        failures += 1
        say("FAIL \(message)")
    }

    private func check(_ ok: Bool, _ message: String) {
        if ok { pass(message) } else { fail(message) }
    }

    private func waitFor(seconds: Double, _ condition: () async -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            if await condition() { return true }
            try? await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < end
        return false
    }

    private func describe(_ w: BrowserWindowController) async {
        let js = "String(location.href) + ' | title: ' + document.title + ' | ' + (document.body ? document.body.innerText.slice(0, 400) : 'no body')"
        let page = await w.evaluate(js)
        say("page: \(page?.replacingOccurrences(of: "\n", with: " ") ?? "no answer from the page (web content not running?)"); web view URL \(w.webView.url?.absoluteString ?? "none")")
    }

    private static func exists(_ pid: Int32, wait seconds: Double) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            if kill(pid, 0) != 0, errno == ESRCH { return false }
            usleep(100_000)
        } while Date() < end
        return true
    }
}

/// Ends a smoke test that hangs (a page that never loads, a web content process that never
/// answers): prints what it was doing, kills the hubs it started, exits 1. Runs off the main thread,
/// so it fires even if the main thread is stuck.
final class SmokeWatchdog: @unchecked Sendable {
    static let shared = SmokeWatchdog()
    private let lock = NSLock()
    private var pids: [Int32] = []
    private var step = "starting the hub"

    func set(step: String) { lock.lock(); self.step = step; lock.unlock() }
    func add(pid: Int32) { lock.lock(); pids.append(pid); lock.unlock() }

    func arm(seconds: Double) {
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
            self.lock.lock()
            let pids = self.pids, step = self.step
            self.lock.unlock()
            say("FAIL the smoke test did not finish within \(Int(seconds)) s; it was at: \(step)")
            say("SMOKE TEST FAILED")
            for p in pids { kill(p, SIGKILL) }
            exit(1)
        }
    }
}
