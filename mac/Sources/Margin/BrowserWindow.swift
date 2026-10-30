// One window with one WKWebView: the Papers window (the hub page), a paper's editor, or an
// ordinary page a paper opened (the raw LaTeX log, a binary file).
//
// A WKWebView does much less than a browser by itself. This class supplies what Margin's pages
// rely on: JavaScript alert/confirm/prompt panels (without them confirm() silently returns false
// and Remove, Accept all, Delete do nothing), file open panels, downloads (see Downloads.swift),
// new windows for target=_blank and window.open, and the rule that only 127.0.0.1, localhost
// and [::1] are shown in the app: every other link opens in the default browser.
import AppKit
import WebKit

@MainActor
final class BrowserWindowController: NSWindowController, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    enum Kind {
        case papers
        case paper
        case other
    }

    let kind: Kind
    let webView: WKWebView
    /// The paper's port, for a paper window: one window per paper.
    var paperPort: Int?
    private(set) var restoredFrame = false
    private weak var manager: WindowManager?
    private var titleObservation: NSKeyValueObservation?
    private let zoomKey: String?
    private var failedURL: URL?
    private var closingAfterFlush = false

    init(kind: Kind, configuration: WKWebViewConfiguration, manager: WindowManager, frameKey: String?, size: NSSize) {
        self.kind = kind
        self.manager = manager
        zoomKey = frameKey.map { "Margin.zoom.\($0)" }
        let screen = NSScreen.main?.visibleFrame.size ?? size
        let frame = NSRect(x: 0, y: 0, width: min(size.width, screen.width * 0.95), height: min(size.height, screen.height * 0.95))
        let web = WKWebView(frame: frame, configuration: configuration)
        webView = web
        let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Margin"
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed // a window per paper, not tabs
        window.minSize = NSSize(width: 560, height: 380)
        window.contentView = web
        super.init(window: window)
        shouldCascadeWindows = false // WindowManager places windows (remembered frame, or cascaded)
        window.delegate = self
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false // a stray two-finger swipe must not leave the editor
        if #available(macOS 13.3, *) { webView.isInspectable = true } // Develop menu / Web Inspector for debugging
        if let frameKey {
            let name = "Margin.window.\(frameKey)"
            restoredFrame = window.setFrameUsingName(name)
            window.setFrameAutosaveName(name)
        }
        if let zoomKey, let z = UserDefaults.standard.object(forKey: zoomKey) as? Double { webView.pageZoom = CGFloat(z) }
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.updateTitle() }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func load(_ url: URL) {
        failedURL = nil
        webView.load(URLRequest(url: url))
    }

    func bringToFront() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    private func updateTitle() {
        let t = webView.title ?? ""
        window?.title = t.isEmpty ? "Margin" : t
    }

    /// Runs JavaScript and returns its value if it is a string (nil otherwise, or after `timeout`).
    func evaluate(_ js: String, timeout: Double = 5) async -> String? {
        let answer = OneShot<String?>()
        webView.evaluateJavaScript(js) { value, _ in answer.fulfill(value as? String) }
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            answer.fulfill(nil)
        }
        let value = await answer.wait()
        timer.cancel()
        return value
    }

    /// The editor saves 0.7 s after the last keystroke, and its beforeunload handler saves at once
    /// when there is something unsaved (and cancels the event). A web view that is closed or whose
    /// server stops gets no beforeunload, so fire it before closing a paper window or quitting.
    /// Returns true if there was something to save.
    func flushEdits() async -> Bool {
        guard kind == .paper else { return false }
        let js = "(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return String(e.defaultPrevented); })()"
        return await evaluate(js, timeout: 2) == "true"
    }

    // MARK: - menu actions (View menu; reach the key window's controller through the responder chain)

    @objc func reloadPage(_ sender: Any?) {
        if let url = failedURL { load(url) } else { webView.reload() }
    }

    @objc func zoomInPage(_ sender: Any?) { setZoom(webView.pageZoom * 1.1) }
    @objc func zoomOutPage(_ sender: Any?) { setZoom(webView.pageZoom / 1.1) }
    @objc func actualSizePage(_ sender: Any?) { setZoom(1) }

    private func setZoom(_ z: CGFloat) {
        let v = min(max(z, 0.5), 3)
        webView.pageZoom = abs(v - 1) < 0.01 ? 1 : v
        if let zoomKey { UserDefaults.standard.set(Double(webView.pageZoom), forKey: zoomKey) }
    }

    // MARK: - NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard kind == .paper, !closingAfterFlush else { return true }
        closingAfterFlush = true
        Task {
            if await self.flushEdits() {
                sender.orderOut(nil)
                try? await Task.sleep(nanoseconds: 1_000_000_000) // the save is a local request: plenty
            }
            sender.close()
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        // Let AppKit finish closing before this controller (the window's delegate) may be released.
        let manager = manager
        Task { @MainActor in manager?.closed(self) }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let mainFrame = navigationAction.targetFrame?.isMainFrame // nil: a new window (see createWebViewWith)
        switch Links.kind(of: url) {
        case .inPage:
            decisionHandler(.allow)
        case .blocked:
            decisionHandler(.cancel)
        case .external:
            decisionHandler(.cancel)
            if mainFrame != false || navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        case .local:
            // A paper's "‹ Papers" link (a plain link to the hub's /): show the Papers window
            // instead of turning the paper's window into a second list.
            let manager = manager
            if mainFrame == true, kind != .papers, let manager, manager.isHubRoot(url) {
                decisionHandler(.cancel)
                manager.showPapers()
                if let current = webView.url, manager.hubOpenID(current) != nil { window?.close() } // the "Opening…" page
                return
            }
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard let url = webView.url, Links.isLoopback(url) else { return }
        failedURL = nil
        if kind == .paper, let port = manager?.paperPort(url) { paperPort = port }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    /// A page that could not be reached (a stopped paper, a hub that went away): say so rather than
    /// leave a blank window. Cancelled loads (a download, a link sent to the browser) are not errors.
    private func showLoadError(_ error: Error) {
        let e = error as NSError
        guard e.domain == NSURLErrorDomain, e.code != NSURLErrorCancelled else { return }
        let url = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
        failedURL = url
        let hint = kind == .papers
            ? "The Margin hub is not answering. Quit Margin and open it again."
            : "If this is a paper, its editor may have stopped: open it again from the Papers window (Window → Papers)."
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Margin</title>
        <body style="font: 14px -apple-system, sans-serif; padding: 3em; max-width: 40em; line-height: 1.5">
        <h2>Could not load \(Self.escape(url?.absoluteString ?? "the page"))</h2>
        <p>\(Self.escape(hint))</p><p style="opacity: .7">\(Self.escape(e.localizedDescription))</p>
        <p>View → Reload Page (⌘R) tries again.</p></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: - WKUIDelegate: windows

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        manager?.webView(createWith: configuration, for: navigationAction)
    }

    func webViewDidClose(_ webView: WKWebView) {
        window?.close() // window.close() from the page
    }

    // MARK: - WKUIDelegate: JavaScript panels

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        if SmokeTest.isActive { SmokeTest.dialog("alert", message); completionHandler(); return }
        let alert = Self.panel(message)
        alert.addButton(withTitle: "OK")
        present(alert) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        if SmokeTest.isActive { SmokeTest.dialog("confirm", message); completionHandler(true); return }
        let alert = Self.panel(message)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        present(alert) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        if SmokeTest.isActive { SmokeTest.dialog("prompt", prompt); completionHandler("smoke-answer"); return }
        let alert = Self.panel(prompt)
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        present(alert) { response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        if SmokeTest.isActive { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        let done: (NSApplication.ModalResponse) -> Void = { response in completionHandler(response == .OK ? panel.urls : nil) }
        if let window { panel.beginSheetModal(for: window, completionHandler: done) } else { done(panel.runModal()) }
    }

    /// Margin's messages are often "Question?\n\nDetails": the first paragraph becomes the headline.
    private static func panel(_ message: String) -> NSAlert {
        let alert = NSAlert()
        let parts = message.components(separatedBy: "\n\n")
        if parts.count > 1, parts[0].count <= 200 {
            alert.messageText = parts[0]
            alert.informativeText = parts.dropFirst().joined(separator: "\n\n")
        } else {
            alert.messageText = message
        }
        return alert
    }

    private func present(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window, window.isVisible, window.attachedSheet == nil {
            alert.beginSheetModal(for: window, completionHandler: done)
        } else {
            done(alert.runModal())
        }
    }
}
