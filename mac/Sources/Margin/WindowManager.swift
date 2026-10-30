// Which window shows what: one Papers window (the hub page), one window per paper (found by the
// paper's port, which never changes), and ordinary windows for pages a paper opens itself.
// Window frames are remembered per paper (by port) and for the Papers window.
import AppKit
import WebKit

@MainActor
final class WindowManager {
    let hub: HubController
    private(set) var papersWindow: BrowserWindowController?
    private(set) var controllers: [BrowserWindowController] = []
    private(set) var papers: [Paper] = [] // the hub's list, as last fetched
    var onPapersChanged: (([Paper]) -> Void)?
    private var opening: Set<String> = []
    private var cascadePoint = NSPoint.zero

    init(hub: HubController) { self.hub = hub }

    var paperWindows: [BrowserWindowController] { controllers.filter { $0.kind == .paper } }

    // MARK: - what a URL is

    func isHubRoot(_ url: URL) -> Bool {
        Links.isLoopback(url) && url.port == hub.port && (url.path.isEmpty || url.path == "/")
    }

    /// The paper id in the hub's /open/<id> (the page that starts a paper, then becomes it).
    func hubOpenID(_ url: URL) -> String? {
        guard Links.isLoopback(url), url.port == hub.port else { return nil }
        let parts = url.path.split(separator: "/")
        guard parts.count == 2, parts[0] == "open", parts[1].count == 12, parts[1].allSatisfy({ $0.isHexDigit }) else { return nil }
        return String(parts[1])
    }

    /// The port of a paper's own server (any loopback port but the hub's).
    func paperPort(_ url: URL) -> Int? {
        guard Links.isLoopback(url), let port = url.port, port != hub.port else { return nil }
        return port
    }

    // MARK: - windows

    func showPapers() {
        if let w = papersWindow {
            w.bringToFront()
            return
        }
        let c = BrowserWindowController(kind: .papers, configuration: Self.configuration(), manager: self, frameKey: "papers", size: NSSize(width: 1000, height: 740))
        if !c.restoredFrame { c.window?.center() }
        papersWindow = c
        controllers.append(c)
        c.load(hub.url)
        c.bringToFront()
    }

    /// After the hub restarted: show the list again.
    func reloadPapers() {
        papersWindow?.load(hub.url)
    }

    /// Opens a paper in its own window, or brings its window forward if it has one. Goes through the
    /// hub's /open/<id>, which starts the paper if needed and then turns into it.
    func openPaper(id: String, port knownPort: Int? = nil) {
        guard !opening.contains(id) else { return }
        opening.insert(id)
        Task {
            defer { self.opening.remove(id) }
            var port = knownPort ?? self.papers.first(where: { $0.id == id })?.port
            if port == nil { port = await self.refreshPapers()?.first(where: { $0.id == id })?.port }
            if let port, let existing = self.window(forPaperPort: port) {
                existing.bringToFront()
                return
            }
            let c = self.makeWindow(kind: .paper, configuration: Self.configuration(), frameKey: port.map { "paper-\($0)" })
            c.paperPort = port
            c.load(URL(string: "open/\(id)", relativeTo: self.hub.url)!.absoluteURL)
            c.bringToFront()
        }
    }

    /// A link straight to a running paper's server.
    func openPaper(port: Int, url: URL) {
        if let existing = window(forPaperPort: port) {
            existing.bringToFront()
            return
        }
        let c = makeWindow(kind: .paper, configuration: Self.configuration(), frameKey: "paper-\(port)")
        c.paperPort = port
        c.load(url)
        c.bringToFront()
    }

    func window(forPaperPort port: Int) -> BrowserWindowController? {
        controllers.first { $0.kind == .paper && $0.paperPort == port }
    }

    @discardableResult
    func refreshPapers() async -> [Paper]? {
        guard let list = try? await hub.client.papers() else { return nil }
        papers = list
        onPapersChanged?(list)
        return list
    }

    /// Before quitting: let every editor save what it has not saved yet.
    func flushEdits() async {
        var any = false
        for c in paperWindows {
            if await c.flushEdits() { any = true }
        }
        if any { try? await Task.sleep(nanoseconds: 1_000_000_000) }
    }

    func closed(_ c: BrowserWindowController) {
        if c === papersWindow { return } // kept: the list comes back as it was
        controllers.removeAll { $0 === c }
    }

    /// target=_blank and window.open (WKUIDelegate). A paper opened from the hub gets its own
    /// window (returning nil tells WebKit not to make one; we open it ourselves). Anything else a
    /// page opens gets an ordinary window, whose web view WebKit requires to use `configuration`.
    func webView(createWith configuration: WKWebViewConfiguration, for action: WKNavigationAction) -> WKWebView? {
        if let url = action.request.url, !url.absoluteString.isEmpty, url.absoluteString != "about:blank" {
            switch Links.kind(of: url) {
            case .external:
                NSWorkspace.shared.open(url)
                return nil
            case .blocked:
                return nil
            case .local:
                if isHubRoot(url) {
                    showPapers()
                    return nil
                }
                if let id = hubOpenID(url) {
                    openPaper(id: id)
                    return nil
                }
                if let port = paperPort(url), url.path.isEmpty || url.path == "/" {
                    openPaper(port: port, url: url)
                    return nil
                }
            case .inPage:
                break
            }
        }
        // window.open('') that the page then writes into (the raw LaTeX log), or a file a paper
        // opens (a binary file from the Files pane).
        let c = makeWindow(kind: .other, configuration: configuration, frameKey: nil)
        c.bringToFront()
        return c.webView
    }

    private func makeWindow(kind: BrowserWindowController.Kind, configuration: WKWebViewConfiguration, frameKey: String?) -> BrowserWindowController {
        let size = kind == .paper ? NSSize(width: 1500, height: 940) : NSSize(width: 900, height: 700)
        let c = BrowserWindowController(kind: kind, configuration: configuration, manager: self, frameKey: frameKey, size: size)
        if !c.restoredFrame, let w = c.window {
            w.center()
            cascadePoint = w.cascadeTopLeft(from: cascadePoint)
        }
        controllers.append(c)
        return c
    }

    static func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // shared by all windows (the theme's localStorage, for one)
        // Only Margin's own pages run here, and every window they open goes through
        // webView(createWith:for:). Raw log calls window.open after awaiting a request, when
        // WebKit may no longer count the click as a user gesture and would block the window.
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        return config
    }
}
