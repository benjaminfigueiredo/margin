// `Margin --smoke-test` (or MARGIN_SMOKE_TEST=1): the app checks itself, for CI.
//
// It starts its own hub (never attaching to a running one) on port 47242 (MARGIN_HUB_PORT) with a
// temporary config folder, then checks: the Papers page loads and its script runs; if
// MARGIN_SMOKE_PAPER names a paper folder, a copy of it opens in its own window, the editor
// boots and its WebSocket connects, JavaScript dialogs are answered, opening it again focuses
// the same window; a hub whose stdin closes exits by itself; and quitting through the normal
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

        let running = await windows.refreshPapers()?.first { $0.id == paper.id }
        if let pid = running?.pid {
            paperPid = Int32(pid)
            SmokeWatchdog.shared.add(pid: Int32(pid))
        }
        check(running?.state == "running" && paperPid != nil, "the hub reports the paper running (pid \(paperPid.map { String($0) } ?? "none"))")

        await stdinCheck(hub)
        quit()
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
        NSApp.terminate(nil)
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
