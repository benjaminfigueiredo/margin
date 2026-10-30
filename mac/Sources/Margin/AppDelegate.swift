// The app: starts (or attaches to) the hub, shows the Papers window, opens papers from the File
// menu, Finder and the Dock, adds notes dropped on it to a paper's context, answers the pages'
// messages (notifications, split screen with Claude), and stops the hub on quit.
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let helpURL = URL(string: "https://github.com/benjaminfigueiredo/margin#readme")!

    let hub: HubController
    let windows: WindowManager
    let smoke: SmokeTest?
    let notifier: Notifier
    let terminal: ClaudeTerminal
    let notes: NoteDrop
    var fileMenu: NSMenu?
    var recentMenu: NSMenu?
    private var hubReady = false
    private var pendingFolders: [URL] = [] // opened from Finder before the hub was ready
    private var pendingDrops: [URL] = [] // the same for notes
    private var terminating = false
    private var replied = false
    private var quitWatchdog: Timer?

    override init() {
        let env = ProcessInfo.processInfo.environment
        let smokeMode = CommandLine.arguments.contains("--smoke-test") || env["MARGIN_SMOKE_TEST"] == "1"
        // MARGIN_RESOURCES: a checkout of Margin, for running the executable outside its bundle.
        let resources = env["MARGIN_RESOURCES"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL!.appendingPathComponent("margin")
        let smoke = smokeMode ? SmokeTest() : nil
        let port = Int(env["MARGIN_HUB_PORT"] ?? "") ?? (smokeMode ? 47242 : 4242)
        let logDir = smoke?.workDir
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Margin")
        let hub = HubController(port: port, resources: resources, logURL: logDir.appendingPathComponent("hub.log"))
        if let smoke {
            // Never touch the author's paper list or a hub they are running.
            hub.allowAttach = false
            hub.extraEnvironment["MARGIN_CONFIG_DIR"] = env["MARGIN_CONFIG_DIR"] ?? smoke.workDir.appendingPathComponent("config").path
        }
        self.hub = hub
        let windows = WindowManager(hub: hub)
        self.windows = windows
        self.smoke = smoke
        notifier = Notifier(smoke: smokeMode)
        terminal = ClaudeTerminal(smoke: smokeMode)
        notes = NoteDrop(hub: hub, windows: windows)
        super.init()
    }

    // MARK: - launch

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenu.build(app: self)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        hub.onUnexpectedExit = { [weak self] message in self?.hubStopped(message) }
        windows.onPapersChanged = { [weak self] _ in self?.rebuildRecent() }
        windows.onPageMessage = { [weak self] message, from in self?.pageMessage(message, from: from) }
        windows.onFilesDropped = { [weak self] urls in self?.openDropped(urls) }
        notifier.onClick = { [weak self] port in self?.showPaper(port: port) }
        notifier.start()
        NSApp.activate(ignoringOtherApps: true)
        Task { await self.startHub() }
    }

    private func startHub() async {
        do {
            try await hub.start()
        } catch {
            if terminating { return }
            let e = error as? AppError
            if let smoke {
                smoke.abortLaunch("the hub did not start: \(e?.title ?? "error"): \(error.localizedDescription)")
            }
            Alerts.show(e?.title ?? "Margin could not start", error.localizedDescription, style: .critical, buttons: ["Quit"])
            AppDelegate.requestQuit()
            return
        }
        hubReady = true
        if windows.papersWindow == nil { windows.showPapers() } else { windows.reloadPapers(); windows.showPapers() }
        await windows.refreshPapers()
        let folders = pendingFolders
        pendingFolders = []
        for f in folders { await addAndOpen(folder: f) }
        let drops = pendingDrops
        pendingDrops = []
        if !drops.isEmpty { openDropped(drops) }
        if let smoke { Task { await smoke.run(self) } }
    }

    private func hubStopped(_ message: String) {
        hubReady = false
        if terminating { return }
        if let smoke {
            smoke.giveUp("the hub exited unexpectedly: \(message)")
            return
        }
        let answer = Alerts.show("The Margin hub stopped", "\(message)\n\nThe papers it ran stopped with it. Restart starts the hub again; then open your papers again from the Papers window.", buttons: ["Restart", "Quit"])
        if answer == .alertFirstButtonReturn {
            Task { await self.startHub() }
        } else {
            AppDelegate.requestQuit()
        }
    }

    // MARK: - opening papers

    func addAndOpen(folder: URL) async {
        guard hubReady else {
            pendingFolders.append(folder)
            return
        }
        do {
            let paper = try await hub.client.addPaper(path: folder.path)
            windows.openPaper(id: paper.id, port: paper.port)
            await windows.refreshPapers()
        } catch {
            Alerts.show("Margin could not open “\(folder.lastPathComponent)”", error.localizedDescription)
        }
    }

    @objc func openFolder(_ sender: Any?) {
        guard hubReady else { NSSound.beep(); return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        panel.message = "Choose the folder that holds your paper (the one with the main .tex file)."
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { await self.addAndOpen(folder: url) }
        }
    }

    @objc func openRecentPaper(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        windows.openPaper(id: id)
    }

    @objc func showPapers(_ sender: Any?) {
        if hubReady { windows.showPapers() } else { NSSound.beep() }
    }

    @objc func openHelp(_ sender: Any?) {
        NSWorkspace.shared.open(Self.helpURL)
    }

    /// Finder's Open With → Margin, and folders or notes dropped on the Dock icon.
    func application(_ application: NSApplication, open urls: [URL]) {
        if smoke != nil { return } // the smoke test calls openDropped / notes.add itself
        openDropped(urls)
    }

    /// Folders open as papers (a .tex file stands for the folder it is in); notes (.md, .txt,
    /// .pdf, ...) go to a paper's private context (NoteDrop.swift). A drop may hold both.
    func openDropped(_ urls: [URL]) {
        guard hubReady else {
            pendingDrops += urls
            return
        }
        var noteFiles: [URL] = [], others: [URL] = []
        for url in urls where url.isFileURL {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                Task { await self.addAndOpen(folder: url) }
            } else if url.pathExtension.lowercased() == "tex" {
                Task { await self.addAndOpen(folder: url.deletingLastPathComponent()) }
            } else if NoteDrop.isNote(url) {
                noteFiles.append(url)
            } else {
                others.append(url)
            }
        }
        if !noteFiles.isEmpty || !others.isEmpty { notes.enqueue(notes: noteFiles, others: others) }
    }

    // MARK: - the pages' messages (PageMessages.swift)

    private func pageMessage(_ message: PageMessage, from c: BrowserWindowController) {
        switch message {
        case .notify(let title, let body, let tag):
            guard c.kind == .paper, let port = c.paperPort else { return }
            notifier.post(title: title, body: body, tag: tag, paperPort: port, inFront: c.isInFront)
        case .splitWithClaude(let id):
            if c.kind == .paper {
                Task { await self.splitWithClaude(c) }
            } else if c.kind == .papers, let id {
                Task { await self.splitWithClaude(paperID: id) }
            }
        }
    }

    /// A notification was clicked: that paper's window, opened again if it was closed.
    private func showPaper(port: Int) {
        NSApp.activate(ignoringOtherApps: true)
        if let c = windows.window(forPaperPort: port) {
            c.bringToFront()
        } else if let p = windows.papers.first(where: { $0.port == port }) {
            windows.openPaper(id: p.id, port: port)
        }
    }

    /// From the Papers page: open the paper's window (if need be), then split.
    private func splitWithClaude(paperID id: String) async {
        windows.openPaper(id: id)
        var found: BrowserWindowController?
        for _ in 0..<80 {
            let port = windows.papers.first(where: { $0.id == id })?.port
            if let port, let c = windows.window(forPaperPort: port), c.paperPort == port {
                found = c
                break
            }
            try? await Task.sleep(nanoseconds: 125_000_000)
        }
        if let found { await splitWithClaude(found) }
    }

    /// The paper's window on the top of its screen, Terminal running claude in the paper folder in
    /// a strip below (SplitScreen.swift).
    func splitWithClaude(_ c: BrowserWindowController) async {
        guard let window = c.window, let port = c.paperPort else { return }
        if window.styleMask.contains(.fullScreen) {
            await Alerts.sheet("Leave full screen first", "Split screen puts this window on the top of the screen and Terminal below it. Leave full screen (View → Exit Full Screen, or ⌃⌘F), then press Claude terminal again.", on: window)
            return
        }
        var paper = windows.papers.first { $0.port == port }
        if paper == nil { paper = await windows.refreshPapers()?.first { $0.port == port } }
        guard let paper else {
            await Alerts.sheet("This paper is not in the Papers list", "Open it from the Papers window (Window → Papers), then press Claude terminal again.", on: window)
            return
        }
        guard let screen = window.screen ?? NSScreen.main, let primary = NSScreen.screens.first else { return }
        let rects = SplitLayout.rects(in: screen.visibleFrame)
        let bounds = SplitLayout.appleScriptBounds(of: rects.terminal, primaryScreenFrame: primary.frame)
        switch await terminal.open(paperPort: port, folder: paper.path, bounds: bounds) {
        case .done:
            window.setFrame(rects.editor, display: true, animate: smoke == nil)
        case .notAllowed:
            let answer = await Alerts.sheet("Margin may not control Terminal", "macOS asked whether Margin may control Terminal, and the answer was no. Allow it in System Settings → Privacy & Security → Automation → Margin (turn on Terminal), then press Claude terminal again.", on: window, buttons: ["Open System Settings", "Cancel"])
            if answer == .alertFirstButtonReturn, smoke == nil, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
                NSWorkspace.shared.open(url)
            }
        case .failed(let why):
            await Alerts.sheet("Could not open Terminal", why, on: window)
        }
    }

    // MARK: - Open Recent

    func menuWillOpen(_ menu: NSMenu) {
        if menu === fileMenu, hubReady { Task { await self.windows.refreshPapers() } }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === recentMenu { rebuildRecent() }
    }

    private func rebuildRecent() {
        guard let menu = recentMenu else { return }
        menu.removeAllItems()
        let papers = windows.papers.prefix(15) // the hub lists the most recently opened first
        if papers.isEmpty {
            menu.addItem(NSMenuItem(title: hubReady ? "No Papers Yet" : "Starting…", action: nil, keyEquivalent: ""))
            return
        }
        for p in papers {
            let i = NSMenuItem(title: p.name, action: #selector(openRecentPaper(_:)), keyEquivalent: "")
            i.target = self
            i.representedObject = p.id
            i.toolTip = p.path
            menu.addItem(i)
        }
    }

    // MARK: - windows and the Dock

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag, hubReady { windows.showPapers() }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if hubReady { Task { await self.windows.refreshPapers() } }
    }

    // MARK: - quitting

    /// Let the editors save, then stop the hub (SIGTERM, SIGKILL after a grace period), then quit.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateCancel } // a second ⌘Q while the first is under way
        guard hub.ownsRunningHub || !windows.paperWindows.isEmpty else { return .terminateNow }
        terminating = true
        armQuitWatchdog()
        Task {
            let problems = await self.windows.saveAndReportUnsaved()
            if !problems.isEmpty {
                // Asking can take as long as the author likes: no watchdog while the alert is up.
                self.quitWatchdog?.invalidate()
                let answer = Alerts.show("Quit without saving?", problems.joined(separator: "\n") + "\n\nCancel to resolve it in the bar above the editor, or quit and lose those edits.", buttons: ["Cancel", "Quit Anyway"])
                if answer == .alertFirstButtonReturn {
                    self.terminating = false
                    NSApp.reply(toApplicationShouldTerminate: false)
                    return
                }
                self.armQuitWatchdog()
            }
            await self.hub.stop()
            self.replyTerminate()
        }
        return .terminateLater
    }

    /// Never hang on the way out, whatever happens in the quit task. A run-loop timer in the common
    /// modes, not a Task: while AppKit waits for our reply it spins the run loop in the modal-panel
    /// mode, and this must fire even if the quit task cannot run.
    private func armQuitWatchdog() {
        quitWatchdog?.invalidate()
        let t = Timer(timeInterval: 15, target: self, selector: #selector(quitWatchdogFired), userInfo: nil, repeats: false)
        RunLoop.main.add(t, forMode: .common)
        quitWatchdog = t
    }

    @objc private func quitWatchdogFired() { replyTerminate() }

    /// Quit through the normal path (applicationShouldTerminate), started from the run loop the way
    /// ⌘Q is. Calling NSApp.terminate directly from a Task would run AppKit's wait for our reply
    /// inside a main-queue block, and GCD does not run other main-queue blocks re-entrantly, so the
    /// shutdown tasks above (and their reply) would never run: the app hung on quit.
    static func requestQuit() {
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }

    private func replyTerminate() {
        guard !replied else { return }
        replied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        hub.terminateNow() // normally already stopped; if not, SIGTERM (and its stdin closes as we exit)
        smoke?.finish(hub: hub)
    }
}
