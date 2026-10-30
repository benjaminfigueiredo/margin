// macOS notifications for a paper's page: Claude is done, needs you, answered your question;
// Overleaf has new commits (the page posts { type: 'notify' }, see PageMessages.swift).
//
// - Shown only when that paper's window is not in front (another window is key, or Margin is not
//   the active app): the page itself shows what happens while the author looks at it.
// - Authorization is asked lazily, with the first notification that would be shown, never at launch.
//   If the author says no (or later turns them off), nothing is shown and nothing is said.
// - Clicking one brings that paper's window forward (the paper's port is in userInfo).
// - The smoke test records what would be posted and never touches UNUserNotificationCenter, which
//   would ask for permission on the CI machine (and which needs a real .app bundle anyway).
import AppKit
import UserNotifications

@MainActor
final class Notifier {
    struct Posted {
        let title: String
        let body: String
        let tag: String
        let paperPort: Int
        let shown: Bool // false: the paper's window was in front, so it was left to the page
    }

    /// Called with a paper's port when the author clicks one of its notifications.
    var onClick: ((Int) -> Void)?
    private(set) var recorded: [Posted] = [] // smoke test only
    private let smoke: Bool
    private let delegate = NotificationDelegate()
    private var askedAuthorization = false

    init(smoke: Bool) { self.smoke = smoke }

    /// UNUserNotificationCenter only works for a real app bundle (not the bare executable run with
    /// MARGIN_RESOURCES from a checkout), and never in the smoke test.
    private var available: Bool {
        !smoke && Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
    }

    /// At launch: only sets the delegate (clicks, and banners while Margin is active). Asks nothing.
    func start() {
        guard available else { return }
        delegate.onClick = { port in
            Task { @MainActor [weak self] in self?.onClick?(port) }
        }
        UNUserNotificationCenter.current().delegate = delegate
    }

    func post(title: String, body: String, tag: String, paperPort: Int, inFront: Bool) {
        if smoke {
            recorded.append(Posted(title: title, body: body, tag: tag, paperPort: paperPort, shown: !inFront))
            say("NOTIFY \(title) | \(body) | tag \(tag) | \(inFront ? "not shown: the paper's window is in front" : "would be shown")")
            return
        }
        guard !inFront, available else { return }
        Task { await self.deliver(title: title, body: body, tag: tag, paperPort: paperPort) }
    }

    private func deliver(title: String, body: String, tag: String, paperPort: Int) async {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        switch status {
        case .denied:
            return
        case .notDetermined:
            if askedAuthorization { return } // asked already this run (the answer is still coming, or was no)
            askedAuthorization = true
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
            if !granted { return }
        default:
            break
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "paper-\(paperPort)"
        content.userInfo = ["paperPort": paperPort]
        // Same paper and tag: replaces the earlier one ("Claude is done" over "Claude needs you").
        let request = UNNotificationRequest(identifier: "paper-\(paperPort)-\(tag)", content: content, trigger: nil)
        try? await center.add(request)
    }
}

/// Not on the main actor: UserNotifications calls it on a queue of its own.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    var onClick: (@Sendable (Int) -> Void)?

    // Margin is active but the paper's window is not key: show the banner anyway.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let port = response.notification.request.content.userInfo["paperPort"] as? Int { onClick?(port) }
        completionHandler()
    }
}
