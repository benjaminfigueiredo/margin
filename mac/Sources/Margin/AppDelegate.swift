// The app: starts (or attaches to) the hub, shows the Papers window, opens papers from the File
// menu, Finder and the Dock, and stops the hub on quit.
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let helpURL = URL(string: "https://github.com/benjaminfigueiredo/margin#readme")!

    let hub: HubController
    let windows: WindowManager
    let smoke: SmokeTest?
    var fileMenu: NSMenu?
    var recentMenu: NSMenu?
    private var hubReady = false
    private var pendingFolders: [URL] = [] // opened from Finder before the hub was ready
    private var terminating = false
    private var replied = false

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
        windows = WindowManager(hub: hub)
        self.smoke = smoke
        super.init()
    }

    // MARK: - launch

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenu.build(app: self)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        hub.onUnexpectedExit = { [weak self] message in self?.hubStopped(message) }
        windows.onPapersChanged = { [weak self] _ in self?.rebuildRecent() }
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
            NSApp.terminate(nil)
            return
        }
        hubReady = true
        if windows.papersWindow == nil { windows.showPapers() } else { windows.reloadPapers(); windows.showPapers() }
        await windows.refreshPapers()
        let folders = pendingFolders
        pendingFolders = []
        for f in folders { await addAndOpen(folder: f) }
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
            NSApp.terminate(nil)
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

    /// Finder's Open With → Margin, and folders dropped on the Dock icon.
    func application(_ application: NSApplication, open urls: [URL]) {
        if smoke != nil { return }
        for url in urls where url.isFileURL {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { continue }
            // A .tex file stands for the folder it is in.
            let folder = isDir.boolValue ? url : url.deletingLastPathComponent()
            Task { await self.addAndOpen(folder: folder) }
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
        Task {
            await self.windows.flushEdits()
            await self.hub.stop()
            self.replyTerminate()
        }
        // Never hang on the way out, whatever happens above.
        Task {
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            self.replyTerminate()
        }
        return .terminateLater
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
