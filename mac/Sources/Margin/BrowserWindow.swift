// One window with one WKWebView: the Papers window (the hub page), a paper's editor, or an
// ordinary page a paper opened (the raw LaTeX log, a binary file).
//
// A WKWebView does much less than a browser by itself. This class supplies what Margin's pages
// rely on: JavaScript alert/confirm/prompt panels (without them confirm() silently returns false
// and Remove, Accept all, Delete do nothing), file open panels, downloads (see Downloads.swift),
// new windows for target=_blank and window.open, and the rule that only 127.0.0.1, localhost
// and [::1] are shown in the app: every other link opens in the default browser. The Papers window
// and paper windows also get the `margin` message handler (PageMessages.swift), and the Papers
// window takes dropped files itself (NoteDrop.swift).
import AppKit
import WebKit

@MainActor
final class BrowserWindowController: NSWindowController, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
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
    private var checkingClose = false
    private let dropView: FileDropView?

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
        if kind == .papers {
            // Files dropped on the list go to the app (notes, folders), not to the page.
            let drop = FileDropView(frame: frame)
            web.frame = drop.bounds
            web.autoresizingMask = [.width, .height]
            drop.addSubview(web)
            web.unregisterDraggedTypes()
            window.contentView = drop
            window.initialFirstResponder = web
            dropView = drop
        } else {
            window.contentView = web
            dropView = nil
        }
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
        // Not for .other windows: their configuration comes from the page that opened them and
        // shares its content controller, which already has the handler.
        if kind != .other {
            webView.configuration.userContentController.add(ScriptMessageProxy(self), name: PageMessage.handlerName)
        }
        dropView?.onDrop = { [weak self] urls in self?.manager?.filesDropped(urls) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func load(_ url: URL) {
        failedURL = nil
        webView.load(URLRequest(url: url))
    }

    func bringToFront() {
        showWindow(nil)
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        window?.makeKeyAndOrderFront(nil)
    }

    /// The author is looking at this window: it is the key window of the active app.
    var isInFront: Bool { NSApp.isActive && window?.isKeyWindow == true }

    // MARK: - WKScriptMessageHandler (the page ↔ app contract, PageMessages.swift)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only this window's own page, in its main frame, from the origin this window is for.
        guard message.webView === webView, message.frameInfo.isMainFrame else { return }
        let origin = message.frameInfo.securityOrigin
        let expected = kind == .paper ? paperPort : kind == .papers ? manager?.hub.port : nil
        guard origin.protocol == "http", Links.loopbackHosts.contains(origin.host.lowercased()), let expected, origin.port == expected else { return }
        guard let m = PageMessage(message.body) else { return }
        manager?.pageMessage(m, from: self)
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

    /// Before closing a paper window or quitting: the page saves what it has not saved yet and says
    /// what is still unsaved (an edit that conflicts with a change on disk, a save that failed).
    /// Returns nil when nothing is at risk, or when the page cannot be asked (then closing loses
    /// nothing the editor knew how to save).
    func saveAndReportUnsaved() async -> String? {
        guard kind == .paper else { return nil }
        let answer = OneShot<String?>()
        webView.callAsyncJavaScript("return window.marginBeforeClose ? await window.marginBeforeClose() : ''", arguments: [:], in: nil, in: .page) { result in
            if case .success(let value) = result { answer.fulfill(value as? String) } else { answer.fulfill(nil) }
        }
        let timer = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            answer.fulfill(nil)
        }
        let value = await answer.wait()
        timer.cancel()
        guard let value, !value.isEmpty else { return nil }
        return value
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
        if checkingClose { return false } // a second click while the page is saving
        checkingClose = true
        Task {
            let problem = await self.saveAndReportUnsaved()
            self.checkingClose = false
            if let problem {
                let answer = Alerts.show("Close without saving?", "\(problem)\n\nKeep the window open to resolve it in the bar above the editor, or close it and lose those edits.", buttons: ["Keep Window Open", "Close Anyway"])
                if answer == .alertFirstButtonReturn { return }
            }
            self.closingAfterFlush = true
            sender.close()
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        if kind == .paper { webView.configuration.userContentController.removeScriptMessageHandler(forName: PageMessage.handlerName) }
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
        if kind == .papers { webView.unregisterDraggedTypes() } // in case WebKit registered them again
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
