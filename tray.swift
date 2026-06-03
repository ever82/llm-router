#!/usr/bin/env swift
// LLM Router · macOS 菜单栏图标
// 用法: ./tray <port>

import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var port: Int = 3000

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.count > 1 {
            port = Int(CommandLine.arguments[1]) ?? 3000
        }

        let statusBar = NSStatusBar.system
        statusItem = statusBar.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.title = "🤖"
            button.toolTip = "LLM Router"
        }

        let menu = NSMenu()

        let titleItem = NSMenuItem(title: "LLM Router", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)
        menu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "📊 打开日志", action: #selector(openLogs), keyEquivalent: "l")
        openItem.target = self
        menu.addItem(openItem)

        let statusItem2 = NSMenuItem(title: "📈 状态面板", action: #selector(openStatus), keyEquivalent: "s")
        statusItem2.target = self
        menu.addItem(statusItem2)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        self.statusItem.menu = menu
    }

    @objc func openLogs() {
        if let url = URL(string: "http://localhost:\(port)/logs") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func openStatus() {
        if let url = URL(string: "http://localhost:\(port)/proxy-status") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
