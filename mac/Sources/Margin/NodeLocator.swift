// Finding the Node.js the author installed, and the PATH the hub runs with.
//
// Margin does not bundle Node: it uses the one on the Mac (20 or later), so Node's security
// updates keep coming from Homebrew, nodejs.org or the version manager the author uses.
//
// An app opened from Finder gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), without
// Homebrew or TeX, so latexmk, git and latexdiff would not be found by the papers the hub runs.
// The hub's PATH is therefore: the login shell's PATH, then the folder Node was found in, then
// /Library/TeX/texbin (MacTeX, BasicTeX), Homebrew and the system folders.
import Darwin
import Foundation

struct Toolchain: Sendable {
    let nodePath: String
    let version: String
    let environment: [String: String]
}

enum NodeLocator {
    static let minimumMajor = 20
    static let fixedPath = ["/Library/TeX/texbin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
                            "/usr/bin", "/bin", "/usr/sbin", "/sbin"]

    /// Blocking (it runs the login shell and `node --version`): call it off the main thread.
    static func locate() throws -> Toolchain {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let inherited = ProcessInfo.processInfo.environment
        let shell = askLoginShell()
        var env = inherited
        env["PATH"] = searchPath(login: shell.path, extra: [], inherited: inherited["PATH"])

        var candidates: [String] = []
        if let override = inherited["MARGIN_NODE"], !override.isEmpty { candidates.append(override) }
        if let fromShell = shell.node { candidates.append(fromShell) }
        candidates += [
            "/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node",
            "\(home)/.volta/bin/node", "\(home)/.asdf/shims/node", "\(home)/.local/share/mise/shims/node",
            "\(home)/.nodenv/shims/node", "\(home)/.local/bin/node",
        ]
        candidates += versionedInstalls(in: "\(home)/.nvm/versions/node", binary: "bin/node")
        candidates += versionedInstalls(in: "\(home)/Library/Application Support/fnm/node-versions", binary: "installation/bin/node")
        candidates += versionedInstalls(in: "\(home)/.local/share/fnm/node-versions", binary: "installation/bin/node")

        var seen = Set<String>()
        var notes: [String] = []
        for path in candidates {
            guard seen.insert(path).inserted, FileManager.default.isExecutableFile(atPath: path) else { continue }
            guard let out = Subprocess.run(path, ["--version"], environment: env, timeout: 15), out.status == 0 else {
                notes.append("\(path) did not run")
                continue
            }
            let version = out.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let major = majorVersion(version) else {
                notes.append("\(path) printed “\(version.prefix(60))”")
                continue
            }
            if major >= minimumMajor {
                var childEnv = env
                let dir = (path as NSString).deletingLastPathComponent
                childEnv["PATH"] = searchPath(login: shell.path, extra: [dir], inherited: inherited["PATH"])
                return Toolchain(nodePath: path, version: version, environment: childEnv)
            }
            notes.append("\(path) is Node \(version)")
        }

        var message = """
        Margin runs on the Node.js installed on your Mac, version \(minimumMajor) or later, and none was found.

        Install it with Homebrew (brew install node) or with the LTS installer from nodejs.org, then open Margin again.
        """
        if !notes.isEmpty { message += "\n\nFound, but not usable:\n" + notes.joined(separator: "\n") }
        throw AppError(title: "Margin needs Node.js", message: message)
    }

    /// The login shell's PATH and `command -v node`. A login shell (-l) reads .zprofile/.zlogin
    /// (and .bash_profile, fish's config), where Homebrew and most version managers set PATH.
    /// Interactive-only setups (nvm in .zshrc) are covered by looking in ~/.nvm directly.
    struct ShellAnswer {
        var path: String?
        var node: String?
    }

    static func askLoginShell() -> ShellAnswer {
        let pathTag = "__MARGIN_PATH__=", nodeTag = "__MARGIN_NODE__="
        // printf in zsh, bash, sh and fish alike; the tags make the answer findable among
        // anything the shell's startup files print.
        let script = "printf '\\n\(pathTag)%s\\n' \"$PATH\"; printf '\(nodeTag)%s\\n' \"$(command -v node)\""
        guard let out = Subprocess.run(userShell(), ["-l", "-c", script], environment: ProcessInfo.processInfo.environment, timeout: 10) else {
            return ShellAnswer()
        }
        var answer = ShellAnswer()
        for line in out.text.split(whereSeparator: \.isNewline) {
            if line.hasPrefix(pathTag) {
                let p = String(line.dropFirst(pathTag.count))
                if !p.isEmpty { answer.path = p }
            } else if line.hasPrefix(nodeTag) {
                let n = String(line.dropFirst(nodeTag.count))
                if n.hasPrefix("/") { answer.node = n }
            }
        }
        return answer
    }

    static func userShell() -> String {
        if let pw = getpwuid(getuid()), let raw = pw.pointee.pw_shell {
            let shell = String(cString: raw)
            let known = ["zsh", "bash", "sh", "fish", "ksh", "dash"]
            if known.contains((shell as NSString).lastPathComponent), FileManager.default.isExecutableFile(atPath: shell) { return shell }
        }
        return "/bin/zsh"
    }

    /// Unique entries, in order: login shell, extra folders, the fixed folders, then what the app got.
    static func searchPath(login: String?, extra: [String], inherited: String?) -> String {
        var parts: [String] = []
        let sources = [login ?? ""] + extra + fixedPath + [inherited ?? ""]
        for source in sources {
            for p in source.split(separator: ":").map(String.init) where !p.isEmpty && !parts.contains(p) {
                parts.append(p)
            }
        }
        return parts.joined(separator: ":")
    }

    /// node binaries under a version manager's folder of "v22.11.0"-style folders, newest first.
    static func versionedInstalls(in dir: String, binary: String) -> [String] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        let versions = names.filter { majorVersion($0) != nil }
        let newestFirst = versions.sorted { a, b in versionKey(b).lexicographicallyPrecedes(versionKey(a)) }
        return newestFirst.map { "\(dir)/\($0)/\(binary)" }
    }

    static func versionKey(_ s: String) -> [Int] {
        let t = s.hasPrefix("v") ? String(s.dropFirst()) : s
        return t.split(separator: ".").map { part in Int(part.prefix(while: { c in c.isNumber })) ?? 0 }
    }

    static func majorVersion(_ s: String) -> Int? {
        guard s.hasPrefix("v") || s.first?.isNumber == true else { return nil }
        let t = s.hasPrefix("v") ? String(s.dropFirst()) : s
        guard let first = t.split(separator: ".").first, let n = Int(first) else { return nil }
        return n
    }
}

/// Runs a short command and collects its stdout, with a timeout. Returns nil if it could not be
/// started or did not finish in time (it is then killed).
enum Subprocess {
    struct Output {
        let status: Int32
        let text: String
    }

    private final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
        var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
    }

    static func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) -> Output? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        let collected = Collector()
        let eof = DispatchSemaphore(value: 0)
        let exited = DispatchSemaphore(value: 0)
        out.fileHandleForReading.readabilityHandler = { handle in
            let d = handle.availableData
            if d.isEmpty {
                handle.readabilityHandler = nil
                eof.signal()
            } else {
                collected.append(d)
            }
        }
        process.terminationHandler = { _ in exited.signal() }
        do { try process.run() } catch {
            out.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            if exited.wait(timeout: .now() + 1) == .timedOut { kill(process.processIdentifier, SIGKILL) }
            out.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        // Something the command started in the background may hold the pipe open: don't wait for it.
        _ = eof.wait(timeout: .now() + 1)
        out.fileHandleForReading.readabilityHandler = nil
        return Output(status: process.terminationStatus, text: collected.text)
    }
}
