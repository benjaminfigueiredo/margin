// Notes dropped on the app: .md, .markdown, .txt, .text and .pdf files dropped on the Dock icon or
// on the Papers window, or opened with Finder's Open With → Margin, go into a paper's private
// context (server/context.js). The app asks which paper (preselecting the one whose window is in
// front, else the most recently opened), starts it through the hub if it is not running, uploads
// each file to the paper's POST /api/context/upload?name=<file name>, and says what happened to
// each one. URLSession sends no Origin, so the paper's cross-site guard lets the upload through.
// Folders are opened as papers, as before (AppDelegate.openDropped). A file dropped on a paper's
// own Context panel is the page's business, not this.
import AppKit

@MainActor
final class NoteDrop {
    static let noteExtensions: Set<String> = ["md", "markdown", "txt", "text", "pdf"]
    static let maxBytes = 20 * 1024 * 1024 // CONTEXT_MAX_BYTES in server/context.js

    struct Result: Equatable {
        let file: String
        let addedAs: String? // the name it got in the context folder ("notes-2.md" if notes.md was taken)
        let problem: String?
    }

    static func isNote(_ url: URL) -> Bool { noteExtensions.contains(url.pathExtension.lowercased()) }

    private let hub: HubController
    private let windows: WindowManager
    private var queue: [(notes: [URL], others: [URL])] = []
    private var draining = false

    init(hub: HubController, windows: WindowManager) {
        self.hub = hub
        self.windows = windows
    }

    /// Drops arrive one after another (several Finder selections, a second drop while the first is
    /// asking): one question at a time.
    func enqueue(notes: [URL], others: [URL]) {
        queue.append((notes: notes, others: others))
        guard !draining else { return }
        draining = true
        Task {
            while !self.queue.isEmpty {
                let next = self.queue.removeFirst()
                _ = await self.add(notes: next.notes, others: next.others)
            }
            self.draining = false
        }
    }

    /// The whole exchange for one drop. Returns what happened to each file (for the smoke test).
    func add(notes: [URL], others: [URL]) async -> [Result] {
        let skipped = others.map { Result(file: $0.lastPathComponent, addedAs: nil, problem: "not a note: Margin adds .md, .markdown, .txt, .text and .pdf files as context") }
        guard !notes.isEmpty else {
            await Alerts.sheet(others.count == 1 ? "Margin cannot add “\(others[0].lastPathComponent)”" : "Margin cannot add these files",
                               "Drop a paper's folder to open it, or notes (.md, .markdown, .txt, .text, .pdf) to add them to a paper's private context.",
                               on: sheetWindow())
            return skipped
        }
        let papers = await windows.refreshPapers() ?? windows.papers
        guard !papers.isEmpty else {
            await Alerts.sheet("No paper to add notes to", "Open a paper first (File → Open Folder…). Notes are added to a paper's private context, for Claude to read.", on: sheetWindow())
            return skipped
        }
        let frontPort = windows.frontmostPaperWindow()?.paperPort
        let preselected = papers.firstIndex { $0.port == frontPort } ?? 0 // the hub lists the most recently opened first
        guard let chosen = await choosePaper(papers, preselected: preselected, notes: notes) else { return [] }

        var paper = chosen
        if paper.state != "running" {
            do { paper = try await hub.client.startPaper(id: chosen.id) } catch {
                await Alerts.sheet("Margin could not start “\(chosen.name)”", error.localizedDescription, on: sheetWindow())
                return []
            }
            guard paper.state == "running" else {
                await Alerts.sheet("Margin could not start “\(chosen.name)”", paper.error ?? "It is \(paper.state).", on: sheetWindow())
                return []
            }
        }
        var results: [Result] = []
        for url in notes { results.append(await upload(url, port: paper.port)) }
        results += skipped
        await report(results, paper: paper)
        return results
    }

    // MARK: - steps

    private func sheetWindow() -> NSWindow? {
        if let w = windows.frontmostPaperWindow()?.window { return w }
        windows.showPapers()
        return windows.papersWindow?.window
    }

    private func choosePaper(_ papers: [Paper], preselected: Int, notes: [URL]) async -> Paper? {
        let alert = NSAlert()
        alert.messageText = notes.count == 1 ? "Add “\(notes[0].lastPathComponent)” as context to which paper?" : "Add \(notes.count) notes as context to which paper?"
        let names = notes.count > 1 ? notes.prefix(8).map { $0.lastPathComponent }.joined(separator: "\n") + (notes.count > 8 ? "\n…" : "") + "\n\n" : ""
        alert.informativeText = names + "Margin keeps them in the paper's private context (.review/context/) for Claude to read. They never go to git or Overleaf."
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 320, height: 26), pullsDown: false)
        let counts = Dictionary(papers.map { ($0.name, 1) }, uniquingKeysWith: +)
        for p in papers {
            // Two papers with the same folder name: say which is which. (Menu items, not
            // addItem(withTitle:), which would merge equal titles.)
            let title = counts[p.name, default: 0] > 1 ? "\(p.name) — \(URL(fileURLWithPath: p.path).deletingLastPathComponent().path)" : p.name
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.toolTip = p.path
            popup.menu?.addItem(item)
        }
        popup.selectItem(at: preselected)
        alert.accessoryView = popup
        alert.addButton(withTitle: "Add")
        alert.addButton(withTitle: "Cancel")
        guard await Alerts.sheet(alert, on: sheetWindow()) == .alertFirstButtonReturn else { return nil }
        let i = popup.indexOfSelectedItem
        return papers.indices.contains(i) ? papers[i] : nil
    }

    // Unreserved characters only: everything else (spaces, +, &, accents) is percent-encoded, so the
    // server reads back exactly the file's name.
    private static let queryValue = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

    private func upload(_ url: URL, port: Int) async -> Result {
        let name = url.lastPathComponent
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > Self.maxBytes { return Result(file: name, addedAs: nil, problem: "it is over the \(Self.maxBytes / 1024 / 1024) MB limit") }
        guard let data = try? Data(contentsOf: url) else { return Result(file: name, addedAs: nil, problem: "it could not be read") }
        var c = URLComponents()
        c.scheme = "http"
        c.host = "127.0.0.1"
        c.port = port
        c.path = "/api/context/upload"
        c.percentEncodedQuery = "name=" + (name.addingPercentEncoding(withAllowedCharacters: Self.queryValue) ?? "note")
        guard let endpoint = c.url else { return Result(file: name, addedAs: nil, problem: "its name cannot be sent") }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        do {
            let (body, response) = try await HubClient.session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            if status == 200 { return Result(file: name, addedAs: json?["name"] as? String ?? name, problem: nil) }
            return Result(file: name, addedAs: nil, problem: json?["error"] as? String ?? "the paper answered with status \(status)")
        } catch {
            return Result(file: name, addedAs: nil, problem: error.localizedDescription)
        }
    }

    private func report(_ results: [Result], paper: Paper) async {
        let added = results.filter { $0.addedAs != nil }.count
        let title = added == results.count
            ? "Added \(added == 1 ? "1 note" : "\(added) notes") to “\(paper.name)”"
            : "\(added) of \(results.count) files added to “\(paper.name)”"
        let lines = results.map { r -> String in
            if let a = r.addedAs { return a == r.file ? "\(r.file): added" : "\(r.file): added as \(a)" }
            return "\(r.file): not added, \(r.problem ?? "unknown error")"
        }
        let message = lines.joined(separator: "\n") + (added > 0 ? "\n\nThey are in the paper's Context view; Claude sees them with list_context." : "")
        let answer = await Alerts.sheet(title, message, style: added == results.count ? .informational : .warning, on: sheetWindow(), buttons: ["OK", "Show Paper"])
        if answer == .alertSecondButtonReturn { windows.openPaper(id: paper.id, port: paper.port) }
    }
}

/// The Papers window's content: the web view, plus file drops (the hub page takes none itself).
/// The web view is unregistered for drags, so AppKit hands them to this view, its superview.
final class FileDropView: NSView {
    var onDrop: (([URL]) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func fileURLs(_ sender: NSDraggingInfo) -> [URL] {
        (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? [] : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(sender)
        guard !urls.isEmpty, let onDrop else { return false }
        // After AppKit has finished the drag: what follows may show a sheet.
        DispatchQueue.main.async { onDrop(urls) }
        return true
    }
}
