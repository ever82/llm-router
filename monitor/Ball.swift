import Cocoa
import Foundation

// ─── 配置 ──────────────────────────────────────────────
let MONITOR_URL = "http://localhost:4000/proxy-status"
let POLL_INTERVAL = 2.0
let SMOOTH_ALPHA = 0.35
let ACTIVE_WINDOW: Double = 15.0
let BALL_SIZE: CGFloat = 82

// ─── 颜色 ──────────────────────────────────────────────
let GREEN_IN   = NSColor(red: 0.25, green: 0.73, blue: 0.31, alpha: 1)
let BLUE_OUT   = NSColor(red: 0.35, green: 0.65, blue: 1.0, alpha: 1)
let DIM        = NSColor(white: 0.35, alpha: 1)
let RED        = NSColor.systemRed
let BORDER_OFF = NSColor(white: 0.15, alpha: 1)
let BORDER_ON  = NSColor.systemGreen.withAlphaComponent(0.8)
let BORDER_ERR = NSColor.systemRed.withAlphaComponent(0.8)
let TODAY_CLR  = NSColor(red: 1.0, green: 0.85, blue: 0.0, alpha: 1)

// ─── 自定义 View：修复光标为箭头 ──────────────────────
class BallView: NSView {
  override func resetCursorRects() {
    super.resetCursorRects()
    addCursorRect(bounds, cursor: .arrow)
  }
}

// ─── 悬浮球窗口 ────────────────────────────────────────
class FloatingBall: NSPanel {
  private var line1: CATextLayer!
  private var line2: CATextLayer!
  private var line3: CATextLayer!
  private var bgLayer: CAShapeLayer!
  private var ringLayer: CAShapeLayer!
  private var isDragging = false
  private var dragOffset = NSPoint()

  // 速度追踪
  private var lastInput: Int = -1
  private var lastOutput: Int = -1
  private var lastPollTime: Date = Date()
  private var smoothIn: Double = 0.0
  private var smoothOut: Double = 0.0
  private var lastActiveTime: Date?

  private var todayTotal: Int = 0
  private var hasError = false

  init() {
    let screen = NSScreen.main!.visibleFrame
    let x = screen.maxX - BALL_SIZE - 14
    let y = screen.origin.y + 12

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
    self.hasShadow = false
    self.backgroundColor = .clear
    self.isOpaque = false

    buildUI()
    startPolling()
  }

  private func buildUI() {
    let view = BallView(frame: NSRect(x: 0, y: 0, width: BALL_SIZE, height: BALL_SIZE))
    view.wantsLayer = true
    self.contentView = view
    view.layer?.backgroundColor = NSColor.clear.cgColor

    // 实心圆背景
    bgLayer = CAShapeLayer()
    bgLayer.path = CGPath(ellipseIn: NSRect(x: 0, y: 0, width: BALL_SIZE, height: BALL_SIZE), transform: nil)
    bgLayer.fillColor = NSColor(white: 0.06, alpha: 0.92).cgColor
    view.layer?.addSublayer(bgLayer!)

    // 边框
    ringLayer = CAShapeLayer()
    ringLayer.path = CGPath(ellipseIn: NSRect(x: 2, y: 2, width: BALL_SIZE - 4, height: BALL_SIZE - 4), transform: nil)
    ringLayer.fillColor = nil
    ringLayer.strokeColor = BORDER_OFF.cgColor
    ringLayer.lineWidth = 2
    view.layer?.addSublayer(ringLayer!)

    // 三行：从上到下
    line1 = makeTextLayer(layer: view.layer!, y: BALL_SIZE - 30, fontSize: 13, weight: .bold)
    line2 = makeTextLayer(layer: view.layer!, y: BALL_SIZE - 48, fontSize: 10, weight: .semibold)
    line3 = makeTextLayer(layer: view.layer!, y: BALL_SIZE - 62, fontSize: 10, weight: .semibold)
  }

  private func makeTextLayer(layer: CALayer, y: CGFloat, fontSize: CGFloat, weight: NSFont.Weight) -> CATextLayer {
    let tl = CATextLayer()
    tl.string = ""
    tl.font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: weight) as CFTypeRef
    tl.fontSize = fontSize
    tl.foregroundColor = DIM.cgColor
    tl.alignmentMode = .center
    tl.frame = CGRect(x: 0, y: y, width: BALL_SIZE, height: fontSize + 6)
    tl.isWrapped = false
    tl.truncationMode = .end
    layer.addSublayer(tl)
    return tl
  }

  // ─── 轮询 ──────────────────────────────────────────
  private func startPolling() {
    poll()
    Timer.scheduledTimer(withTimeInterval: POLL_INTERVAL, repeats: true) { [weak self] _ in
      self?.poll()
    }
  }

  private func poll() {
    guard let url = URL(string: MONITOR_URL) else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3

    let task = URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
      guard let self = self else { return }
      DispatchQueue.main.async {
        if error != nil {
          self.hasError = true
          self.showOffline()
          return
        }
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tokenUsage = json["token_usage"] as? [String: Any],
              let totals = tokenUsage["totals"] as? [String: Any] else {
          self.hasError = true
          self.showOffline()
          return
        }

        self.hasError = false
        let curIn = (totals["input"] as? Int ?? 0) + (totals["cache_read"] as? Int ?? 0)
        let curOut = totals["output"] as? Int ?? 0
        let now = Date()

        if self.lastInput >= 0 {
          let dt = now.timeIntervalSince(self.lastPollTime)
          if dt > 0 {
            let rawIn = Double(curIn - self.lastInput) / dt
            let rawOut = Double(curOut - self.lastOutput) / dt
            self.smoothIn = SMOOTH_ALPHA * rawIn + (1 - SMOOTH_ALPHA) * self.smoothIn
            self.smoothOut = SMOOTH_ALPHA * rawOut + (1 - SMOOTH_ALPHA) * self.smoothOut
            if rawIn > 1 || rawOut > 1 {
              self.lastActiveTime = now
            }
          }
        }

        self.lastInput = curIn
        self.lastOutput = curOut
        self.lastPollTime = now

        let byDay = tokenUsage["byDay"] as? [String: Any]
        let todayKey = self.todayKey()
        self.todayTotal = (byDay?[todayKey] as? [String: Any])?["total"] as? Int ?? 0

        self.updateDisplay()
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

  private func updateDisplay() {
    if hasError { return }

    let idleSec = lastActiveTime.map { Date().timeIntervalSince($0) } ?? Double.greatestFiniteMagnitude
    let isActive = idleSec < ACTIVE_WINDOW
    let speedActive = isActive && (smoothIn > 0.5 || smoothOut > 0.5)

    if speedActive {
      ringLayer?.strokeColor = BORDER_ON.cgColor
    } else {
      ringLayer?.strokeColor = BORDER_OFF.cgColor
      smoothIn *= 0.5
      smoothOut *= 0.5
    }

    // 第一行：今日总数（始终金色醒目）
    line1.string = fmtTokens(todayTotal)
    line1.fontSize = 13
    line1.foregroundColor = TODAY_CLR.cgColor

    // 第二行：输入速度
    if isActive {
      line2.string = "+ \(fmtSpeed(smoothIn))"
      line2.foregroundColor = GREEN_IN.cgColor
    } else {
      line2.string = "--"
      line2.foregroundColor = DIM.cgColor
    }

    // 第三行：输出速度
    if isActive {
      line3.string = "- \(fmtSpeed(smoothOut))"
      line3.foregroundColor = BLUE_OUT.cgColor
    } else {
      line3.string = "--"
      line3.foregroundColor = DIM.cgColor
    }
  }

  private func showOffline() {
    line1.string = "OFF"
    line1.foregroundColor = RED.cgColor
    line2.string = ""
    line3.string = ""
    ringLayer?.strokeColor = BORDER_ERR.cgColor
  }

  private func fmtSpeed(_ n: Double) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fK", n / 1_000) }
    if n >= 1 { return String(format: "%.0f", n) }
    return "0"
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

// ─── AppDelegate ───────────────────────────────────────
class AppDelegate: NSObject, NSApplicationDelegate {
  var ball: FloatingBall!

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApplication.shared.setActivationPolicy(.accessory)
    ball = FloatingBall()
    ball.orderFrontRegardless()
  }
}

// ─── 启动 ────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
