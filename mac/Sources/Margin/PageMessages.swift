// The page ↔ app contract. Margin's pages (the Papers page and a paper's editor) ask the app for
// things a browser cannot do through window.webkit.messageHandlers.margin.postMessage(message)
// (web/src/notify.js). Only the hub's and the papers' own pages can post (BrowserWindowController
// checks the frame's origin), and only these messages are understood; anything else is ignored:
//
//   { type: 'notify', title, body, tag }   a notification (Notifier.swift): shown only when that
//                                          paper's window is not in front; a later one with the
//                                          same tag replaces it
//   { type: 'splitWithClaude' }            from a paper: put its window on the top of the screen and
//                                          Terminal running claude in a strip below (SplitScreen.swift)
//   { type: 'splitWithClaude', paper: id } the same from the Papers page, for the paper with that id
//
// The page only posts when the handler exists, so in a browser it keeps its own behaviour.
import WebKit

enum PageMessage: Equatable {
    case notify(title: String, body: String, tag: String)
    case splitWithClaude(paperID: String?)

    static let handlerName = "margin"

    init?(_ body: Any) {
        guard let d = body as? [String: Any], let type = d["type"] as? String else { return nil }
        switch type {
        case "notify":
            let title = Self.clip(d["title"] as? String, 200)
            guard !title.isEmpty else { return nil }
            let tag = Self.clip(d["tag"] as? String, 60)
            self = .notify(title: title, body: Self.clip(d["body"] as? String, 600), tag: tag.isEmpty ? "margin" : tag)
        case "splitWithClaude":
            guard let id = d["paper"] else {
                self = .splitWithClaude(paperID: nil)
                return
            }
            // A hub paper id: 12 hex digits (server/hub.js paperId).
            guard let s = id as? String, s.count == 12, s.allSatisfy({ $0.isHexDigit }) else { return nil }
            self = .splitWithClaude(paperID: s)
        default:
            return nil
        }
    }

    private static func clip(_ s: String?, _ n: Int) -> String {
        let t = (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > n ? String(t.prefix(n - 1)) + "…" : t
    }
}

/// WKUserContentController holds its handlers strongly, and the window controller owns the web view
/// that owns the content controller: a weak hop breaks that cycle.
@MainActor
final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
