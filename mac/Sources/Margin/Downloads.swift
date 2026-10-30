// Downloads from Margin's pages: the PDF's Download link, the diff PDF, the response letter
// export. A WKWebView downloads nothing unless told where: ask with a save panel that starts in
// ~/Downloads. One shared delegate, so a download survives its window being closed.
import AppKit
import WebKit

@MainActor
final class Downloads: NSObject, WKDownloadDelegate {
    static let shared = Downloads()
    private var destinations: [ObjectIdentifier: URL] = [:]

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        if SmokeTest.isActive { completionHandler(nil); return }
        var name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        // <a href="/pdf" download> names the file after the URL: "pdf". Give it its extension.
        if (name as NSString).pathExtension.isEmpty, response.mimeType == "application/pdf" { name += ".pdf" }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        let id = ObjectIdentifier(download)
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let url = panel.url else { completionHandler(nil); return }
            // The panel has already asked whether to replace an existing file; WebKit would refuse to.
            if FileManager.default.fileExists(atPath: url.path) {
                do { try FileManager.default.removeItem(at: url) } catch {
                    Alerts.show("Could not replace \(url.lastPathComponent)", error.localizedDescription)
                    completionHandler(nil)
                    return
                }
            }
            self?.destinations[id] = url
            completionHandler(url)
        }
        if let window = download.webView?.window ?? NSApp.keyWindow {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // Bounces the Downloads stack in the Dock, as Safari does.
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: url.path)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let target = destinations.removeValue(forKey: ObjectIdentifier(download))
        let e = error as NSError
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return }
        Alerts.show("The download failed", "\(target?.lastPathComponent ?? "The file") could not be saved: \(error.localizedDescription)")
    }
}
