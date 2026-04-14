import Cocoa
import Foundation

// ─── 配置 ──────────────────────────────────────────────
let MONITOR_URL = "http://localhost:4000/proxy-status"
let POLL_INTERVAL = 2.0 // 秒
let BALL_SIZE: CGFloat = 72
let CORNER_RADIUS: CGFloat = BALL_SIZE / 2

// ─── 悬浮球窗口 ────────────────────────────────────────
class FloatingBall: NSPanel {
  private var speedLabel: NSTextField!
  private var unitLabel: NSTextField!
  private var todayLabel: NSTextField!
  private var ringLayer: CAShapeLayer!
  private var isDragging = false
  private var dragOffset = NSPoint()

  init() {
    // 获取屏幕尺寸，右上角定位
    let screen = NSScreen.main!.visibleFrame
    let x = screen.maxX - BALL_SIZE - 12
    let y = screen.maxY - BALL_SIZE - 12

    super.init(
      contentRect: NSRect(x: x, y: y, width: BALL_SIZE, height: BALL_SIZE),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )

    self.isFloatingPanel = true
    self.level = .floating
    self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    self.isMovableByWindowBackground = false
    self.hasShadow = true
    self.backgroundColor = .clear
    self.isOpaque = false
    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true

    buildUI()
    startPolling()
  }

  private func buildUI() {
    let view = self.contentView!
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor(white: 0.06, alpha: 0.92).cgColor
    view.layer?.cornerRadius = CORNER_RADIUS

    // 发光边框
    ringLayer = CAShapeLayer()
    ringLayer.path = CGPath(ellipseIn: NSRect(x: 2, y: 2, width: BALL_SIZE - 4, height: BALL_SIZE - 4), transformIn: nil)
    ringLayer.fillColor = nil
    ringLayer.strokeColor = NSColor(white: 0.3, alpha: 1).cgColor
    ringLayer.lineWidth = 2
    view.layer?.addSublayer(ringLayer!)

    // 速度数字
    speedLabel = NSTextField(labelWithString: "--")
    speedLabel.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .bold)
    speedLabel.textColor = .systemGreen
    speedLabel.alignment = .center
    speedLabel.frame = NSRect(x: 0, y: 28, width: BALL_SIZE, height: 22)
    view.addSubview(speedLabel)

    // 单位
    unitLabel = NSTextField(labelWithString: "t/s")
    unitLabel.font = NSFont.systemFont(ofSize: 8, weight: .medium)
    unitLabel.textColor = NSColor(white: 0.4, alpha: 1)
    unitLabel.alignment = .center
    unitLabel.frame = NSRect(x: 0, y: 18, width: BALL_SIZE, height: 14)
    view.addSubview(unitLabel)

    // 今日累计
    todayLabel = NSTextField(labelWithString: "")
    todayLabel.font = NSFont.systemFont(ofSize: 7, weight: .regular)
    todayLabel.textColor = NSColor(white: 0.35, alpha: 1)
    todayLabel.alignment = .center
    todayLabel.frame = NSRect(x: 0, y: 5, width: BALL_SIZE, height: 12)
    view.addSubview(todayLabel)
  }

  // ─── 轮询代理状态 ──────────────────────────────────
  private func startPolling() {
    poll()
    Timer.scheduledTimer(withTimeInterval: POLL_INTERVAL, repeats: true) { [weak self] _ in
      self?.poll()
    }
  }

  private var lastTotal: Int = 0
  private var lastPollTime: Date = Date()

  private func poll() {
    guard let url = URL(string: MONITOR_URL) else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3

    let task = URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
      guard let self = self else { return }
      DispatchQueue.main.async {
        if error != nil {
          self.showOffline()
          return
        }
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tokenUsage = json["token_usage"] as? [String: Any],
              let totals = tokenUsage["totals"] as? [String: Any] else {
          self.showOffline()
          return
        }

        let total = totals["total"] as? Int ?? 0
        let input = totals["input"] as? Int ?? 0
        let output = totals["output"] as? Int ?? 0

        // 计算速度
        let now = Date()
        let dt = now.timeIntervalSince(self.lastPollTime)
        var speed = 0.0
        if dt > 0 && self.lastTotal > 0 {
          speed = Double(total - self.lastTotal) / dt
        }
        self.lastTotal = total
        self.lastPollTime = now

        // 今日总量
        let byDay = tokenUsage["byDay"] as? [String: Any]
        let todayKey = self.todayKey()
        let todayTotal = (byDay?[todayKey] as? [String: Any])?["total"] as? Int ?? 0

        self.updateDisplay(speed: speed, today: todayTotal)
      }
    }
    task.resume()
  }

  private func todayKey() -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "Asia/Shanghai")
    return f.string(from: Date())
  }

  private func updateDisplay(speed: Double, today: Int) {
    if speed < 0.5 {
      speedLabel.stringValue = "0"
      speedLabel.textColor = NSColor(white: 0.4, alpha: 1)
      ringLayer?.strokeColor = NSColor(white: 0.2, alpha: 1).cgColor
      NSApp.dockTile.badgeLabel = nil
    } else {
      speedLabel.stringValue = String(format: "%.1f", speed)
      speedLabel.textColor = .systemGreen
      ringLayer?.strokeColor = NSColor.systemGreen.withAlphaComponent(0.6).cgColor
      NSApp.dockTile.badgeLabel = String(format: "%.0f", speed)
    }
    todayLabel.stringValue = fmtTokens(today)
  }

  private func showOffline() {
    speedLabel.stringValue = "OFF"
    speedLabel.textColor = .systemRed
    ringLayer?.strokeColor = NSColor.systemRed.withAlphaComponent(0.6).cgColor
    todayLabel.stringValue = ""
    NSApp.dockTile.badgeLabel = nil
  }

  private func fmtTokens(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
    return "\(n)"
  }

  // ─── 鼠标事件 ──────────────────────────────────────
  override func mouseDown(with event: NSEvent) {
    isDragging = false
    let pos = event.locationInWindow
    dragOffset = NSPoint(x: pos.x, y: pos.y)
  }

  override func mouseDragged(with event: NSEvent) {
    isDragging = true
    let screenPos = NSEvent.mouseLocation
    let origin = NSPoint(
      x: screenPos.x - dragOffset.x,
      y: screenPos.y - dragOffset.y
    )
    self.setFrameOrigin(origin)
  }

  override func mouseUp(with event: NSEvent) {
    if !isDragging {
      openDashboard()
    }
  }

  private func openDashboard() {
    let script = "tell application \"Terminal\" to do script \"node \(NSHomeDirectory())/manage/llm-proxy/monitor/monitor.mjs\""
    let appleScript = NSAppleScript(source: script)
    appleScript?.executeAndReturnError(nil)
  }
}

// ─── AppDelegate ────────────────────────────────────────
class AppDelegate: NSObject, NSApplicationDelegate {
  var ball: FloatingBall!

  func applicationDidFinishLaunching(_ notification: Notification) {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory) // 不显示 Dock 图标
    ball = FloatingBall()
    ball.orderFrontRegardless()
    RunLoop.current.run()
  }
}

// ─── 启动 ────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
