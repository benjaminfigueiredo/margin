// The menu bar. A WKWebView gets ⌘C, ⌘V, ⌘Z and friends only through an Edit menu, so it must
// exist even though the page does the editing. Key equivalents reach the page first: Margin's own
// shortcuts (⌘S, ⌘Enter, ⌘F in the PDF, ⇧⌘F) keep working, and what the page leaves alone falls
// through to these items.
import AppKit

@MainActor
enum MainMenu {
    static func build(app: AppDelegate) -> NSMenu {
        let main = NSMenu()

        let appMenu = submenu(main, "Margin")
        appMenu.addItem(item("About Margin", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        appMenu.addItem(.separator())
        let services = NSMenu(title: "Services")
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        appMenu.addItem(servicesItem)
        NSApp.servicesMenu = services
        appMenu.addItem(.separator())
        appMenu.addItem(item("Hide Margin", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        appMenu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Quit Margin", #selector(NSApplication.terminate(_:)), "q"))

        let file = submenu(main, "File")
        file.addItem(item("Open Folder…", #selector(AppDelegate.openFolder(_:)), "o", target: app))
        let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let recent = NSMenu(title: "Open Recent")
        recentItem.submenu = recent
        file.addItem(recentItem)
        file.addItem(.separator())
        file.addItem(item("Close Window", #selector(NSWindow.performClose(_:)), "w"))
        file.delegate = app
        recent.delegate = app
        app.fileMenu = file
        app.recentMenu = recent

        let edit = submenu(main, "Edit")
        edit.addItem(item("Undo", Selector(("undo:")), "z"))
        edit.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]))
        edit.addItem(item("Delete", #selector(NSText.delete(_:))))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))

        let view = submenu(main, "View")
        view.addItem(item("Reload Page", #selector(BrowserWindowController.reloadPage(_:)), "r"))
        view.addItem(.separator())
        view.addItem(item("Actual Size", #selector(BrowserWindowController.actualSizePage(_:)), "0"))
        view.addItem(item("Zoom In", #selector(BrowserWindowController.zoomInPage(_:)), "+"))
        let zoomInEquals = item("Zoom In", #selector(BrowserWindowController.zoomInPage(_:)), "=") // ⌘= without Shift
        zoomInEquals.isHidden = true
        zoomInEquals.allowsKeyEquivalentWhenHidden = true
        view.addItem(zoomInEquals)
        view.addItem(item("Zoom Out", #selector(BrowserWindowController.zoomOutPage(_:)), "-"))
        view.addItem(.separator()) // AppKit adds Enter Full Screen below

        let window = submenu(main, "Window")
        window.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        window.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        window.addItem(.separator())
        window.addItem(item("Papers", #selector(AppDelegate.showPapers(_:)), "p", [.command, .shift], target: app))
        window.addItem(.separator())
        window.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))))
        NSApp.windowsMenu = window

        let help = submenu(main, "Help")
        help.addItem(item("Margin on GitHub", #selector(AppDelegate.openHelp(_:)), "?", target: app))
        NSApp.helpMenu = help

        return main
    }

    private static func submenu(_ main: NSMenu, _ title: String) -> NSMenu {
        let menu = NSMenu(title: title)
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        main.addItem(holder)
        return menu
    }

    private static func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = modifiers
        i.target = target
        return i
    }
}
