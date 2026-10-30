// The hub process (`margin hub`, see README "For programs that start the hub") and its HTTP API.
//
// - Start: `node <Resources>/margin/bin/margin.js hub --no-open --port 4242 --exit-with-stdin`,
//   then wait for `MARGIN_HUB_READY <url>` on stdout.
// - Attach: if a hub already answers on the port (GET /api/hub says hub: true), use it, and leave
//   it running on quit: it belongs to whoever started it.
// - Stop: SIGTERM (the hub stops its papers and exits), SIGKILL after a grace period.
// - If the app dies without stopping it (crash, force quit), the hub's stdin, a pipe only the app
//   holds open, closes and the hub stops by itself (--exit-with-stdin). Papers stop with the hub.
import Darwin
import Foundation

struct Paper: Decodable, Sendable {
    let id: String
    let name: String
    let path: String
    let port: Int
    let url: String
    let state: String
    let pid: Int?
    let error: String? // why it is in the "error" state
}

/// Requests to the hub's API. URLSession sends no Origin and no Sec-Fetch-Site, so the hub's
/// cross-site guard lets them through; don't add an Origin header.
struct HubClient: Sendable {
    let base: URL

    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.connectionProxyDictionary = [:] // never through a proxy: this is 127.0.0.1
        return URLSession(configuration: c)
    }()

    private struct Failure: Decodable { let error: String }
    private struct Hello: Decodable { let hub: Bool }
    private struct PaperList: Decodable { let papers: [Paper] }

    func endpoint(_ path: String) -> URL { URL(string: path, relativeTo: base)!.absoluteURL }

    func isHub(timeout: TimeInterval = 1.5) async -> Bool {
        let request = URLRequest(url: endpoint("api/hub"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        guard let answer = try? await Self.session.data(for: request),
              (answer.1 as? HTTPURLResponse)?.statusCode == 200,
              let hello = try? JSONDecoder().decode(Hello.self, from: answer.0) else { return false }
        return hello.hub
    }

    func papers() async throws -> [Paper] {
        try await send("api/papers", method: "GET", body: nil, as: PaperList.self).papers
    }

    /// POST /api/papers: the hub checks the folder (it must hold a .tex file) and gives it a port.
    func addPaper(path: String) async throws -> Paper {
        let body = try JSONSerialization.data(withJSONObject: ["path": path])
        return try await send("api/papers", method: "POST", body: body, as: Paper.self)
    }

    /// POST /api/papers/<id>/start: starts the paper if it is not running; answers when it runs
    /// (state "running") or could not start (state "error", and why in `error`).
    func startPaper(id: String) async throws -> Paper {
        try await send("api/papers/\(id)/start", method: "POST", body: Data("{}".utf8), as: Paper.self)
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?, as type: T.Type) async throws -> T {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await Self.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "The hub answered with status \(status)."
            throw AppError(title: "The hub refused", message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

@MainActor
final class HubController {
    private enum Outcome: Sendable {
        case ready
        case exited(Int32)
        case timedOut
    }

    static let readyPrefix = "MARGIN_HUB_READY "
    static let startTimeout: UInt64 = 60
    static let stopGrace: Double = 6 // the hub itself waits up to 5 s for each paper

    let port: Int
    let url: URL
    let client: HubClient
    let resources: URL // the folder holding bin/margin.js
    let logURL: URL
    var extraEnvironment: [String: String] = [:]
    var allowAttach = true
    /// Called when a hub this app started exits without being asked to (with a message for an alert).
    var onUnexpectedExit: ((String) -> Void)?

    private(set) var attached = false
    private(set) var nodeDescription = ""
    private var process: Process?
    private var stdinPipe: Pipe?
    private var ready = false
    private var stopping = false

    init(port: Int, resources: URL, logURL: URL) {
        self.port = port
        self.resources = resources
        self.logURL = logURL
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        self.url = url
        client = HubClient(base: url)
    }

    var isRunning: Bool { process?.isRunning ?? false }
    var pid: Int32? { isRunning ? process?.processIdentifier : nil }
    /// A hub this app started and must stop.
    var ownsRunningHub: Bool { !attached && isRunning }

    func start() async throws {
        stopping = false
        ready = false
        attached = false
        if allowAttach, await client.isHub() {
            attached = true
            nodeDescription = "an already running hub"
            return
        }
        let script = resources.appendingPathComponent("bin/margin.js")
        guard FileManager.default.isReadableFile(atPath: script.path) else {
            throw AppError(title: "Margin is incomplete", message: "\(script.path) is missing. Build the app again with mac/build-app.sh.")
        }
        let toolchain: Toolchain = try await withCheckedThrowingContinuation { c in
            DispatchQueue.global(qos: .userInitiated).async {
                do { c.resume(returning: try NodeLocator.locate()) } catch { c.resume(throwing: error) }
            }
        }
        nodeDescription = "Node \(toolchain.version) (\(toolchain.nodePath))"

        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = open(logURL.path, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND, 0o644)
        guard fd >= 0 else { throw AppError(title: "Margin could not start", message: "Could not write its log, \(logURL.path).") }
        let log = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        log.write(Data("--- \(Date()) Margin.app: \(nodeDescription) \(script.path) hub --port \(port)\n".utf8))

        let process = Process()
        process.executableURL = URL(fileURLWithPath: toolchain.nodePath)
        process.arguments = [script.path, "hub", "--no-open", "--port", String(port), "--exit-with-stdin"]
        process.environment = toolchain.environment.merging(extraEnvironment) { _, new in new }
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input // the app keeps the write end open, and never writes
        process.standardOutput = output
        process.standardError = log

        let outcome = OneShot<Outcome>()
        let prefix = Self.readyPrefix
        let lines = LineSplitter { line in
            log.write(Data((line + "\n").utf8))
            if line.hasPrefix(prefix) { outcome.fulfill(.ready) }
        }
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                lines.finish()
            } else {
                lines.feed(data)
            }
        }
        process.terminationHandler = { [weak self] p in
            let status = p.terminationStatus
            let owner = self
            outcome.fulfill(.exited(status))
            Task { @MainActor in owner?.exited(status: status) }
        }
        do { try process.run() } catch {
            throw AppError(title: "Margin could not start", message: "Could not run \(toolchain.nodePath): \(error.localizedDescription)")
        }
        self.process = process
        stdinPipe = input

        let timer = Task {
            try? await Task.sleep(nanoseconds: Self.startTimeout * 1_000_000_000)
            if !Task.isCancelled { outcome.fulfill(.timedOut) }
        }
        let result = await outcome.wait()
        timer.cancel()
        switch result {
        case .ready:
            guard process.isRunning else {
                closeStdin()
                throw AppError(title: "The Margin hub stopped", message: "It stopped right after starting.\n\n\(logTail())\n\nLog: \(logURL.path)")
            }
            ready = true
        case .exited(let status):
            closeStdin()
            throw AppError(title: "The Margin hub did not start", message: "It exited with status \(status).\n\n\(logTail())\n\n\(nodeDescription)\nLog: \(logURL.path)")
        case .timedOut:
            await stop()
            throw AppError(title: "The Margin hub did not start", message: "It did not report that it was ready within \(Self.startTimeout) seconds.\n\n\(logTail())\n\nLog: \(logURL.path)")
        }
    }

    private func exited(status: Int32) {
        closeStdin()
        guard ready, !stopping else { return }
        ready = false
        onUnexpectedExit?("It exited with status \(status).\n\n\(logTail())\n\nLog: \(logURL.path)")
    }

    /// SIGTERM, then SIGKILL if it is still there after the grace period. Never stops an attached hub.
    func stop() async {
        stopping = true
        defer { closeStdin() }
        guard !attached, let p = process, p.isRunning else { return }
        p.terminate()
        if await waitForExit(p, seconds: Self.stopGrace) { return }
        kill(p.processIdentifier, SIGKILL)
        _ = await waitForExit(p, seconds: 2)
    }

    /// Last resort on the way out (applicationWillTerminate): no waiting.
    func terminateNow() {
        guard !attached, let p = process, p.isRunning else { return }
        stopping = true
        p.terminate()
    }

    /// What the hub sees when the app goes away: end of file on stdin.
    func closeStdin() {
        guard let pipe = stdinPipe else { return }
        stdinPipe = nil
        try? pipe.fileHandleForWriting.close()
    }

    private func waitForExit(_ p: Process, seconds: Double) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while p.isRunning, Date() < deadline {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return !p.isRunning
    }

    func logTail(lines n: Int = 20) -> String {
        guard let data = FileManager.default.contents(atPath: logURL.path) else { return "" }
        let text = String(decoding: data.suffix(6000), as: UTF8.self)
        return text.split(separator: "\n").suffix(n).joined(separator: "\n")
    }
}
