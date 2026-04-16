#!/usr/bin/env python3
"""
Token Monitor 桌面悬浮球 v2
- 输入/输出分开显示（↑绿色 / ↓蓝色）
- 指数平滑，不会闪烁
- 拖拽移动 / 单击打开 Dashboard / 右键退出
"""

import tkinter as tk
import json
import urllib.request
import subprocess
import os
import math
import time

# ─── 配置 ──────────────────────────────────────────────
PROXY_URL = "http://localhost:4000/proxy-status"
POLL_SEC = 2
# 平滑系数：0 = 完全平滑（不抖），1 = 不平滑（实时）
SMOOTH_ALPHA = 0.35
# 低于此速度视为空闲
IDLE_THRESHOLD = 5.0

# 尺寸
BALL_W = 82
BALL_H = 82

# ─── 颜色 ──────────────────────────────────────────────
# 透明色：仅用于 Windows 窗口透明（macOS 不支持，会被忽略）
TRANSPARENT = "#0d0d1a"  # 与任何球体颜色不同的魔术色
BG_DARK    = "#0d1117"
BG_BALL    = "#161b22"
BORDER_OFF = "#21262d"
BORDER_ON  = "#3fb950"
BORDER_ERR = "#f85149"
GREEN_IN   = "#3fb950"   # 输入箭头颜色
BLUE_OUT   = "#58a6ff"   # 输出箭头颜色
DIM        = "#484f58"
RED        = "#f85149"
YELLOW     = "#d29922"


class FloatingBall:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("TokenBall")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        # Windows 透明色：窗口背景变为完全透明，圆外不再露出黑角
        try:
            self.root.attributes("-transparentcolor", TRANSPARENT)
        except tk.TclError:
            pass  # macOS / Linux 不支持，忽略
        self.root.configure(bg=TRANSPARENT)

        # 初始位置：右上角
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        x = sw - BALL_W - 14
        y = sh - BALL_H - 50
        self.root.geometry(f"{BALL_W}x{BALL_H}+{x}+{y}")

        # Canvas
        self.canvas = tk.Canvas(
            self.root, width=BALL_W, height=BALL_H,
            bg=TRANSPARENT, highlightthickness=0, bd=0
        )
        self.canvas.pack(fill="both", expand=True)

        cx = BALL_W / 2

        # 背景圆
        r = min(BALL_W, BALL_H) / 2 - 3
        cy = BALL_H / 2
        self.bg_circle = self.canvas.create_oval(
            cx - r, cy - r, cx + r, cy + r,
            fill=BG_BALL, outline=BORDER_OFF, width=2
        )

        # 输入行: ↑ 2.1K
        self.in_text = self.canvas.create_text(
            cx, cy - 14, text="--", fill=GREEN_IN,
            font=("Menlo", 11, "bold")
        )
        # 输出行: ↓ 0.8K
        self.out_text = self.canvas.create_text(
            cx, cy + 2, text="--", fill=BLUE_OUT,
            font=("Menlo", 11, "bold")
        )
        # 今日累计
        self.today_text = self.canvas.create_text(
            cx, cy + 20, text="", fill=DIM,
            font=("Menlo", 7)
        )

        # 事件绑定
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Double-Button-1>", self._open_dashboard)
        self.canvas.bind("<Button-2>", self._quit)
        self.canvas.bind("<Button-3>", self._quit)

        self._drag_x = 0
        self._drag_y = 0
        self._dragged = False

        # 速度追踪（带平滑）
        self._last_input = -1
        self._last_output = -1
        self._last_time = None
        self._smooth_in = 0.0    # 平滑后的输入速度
        self._smooth_out = 0.0   # 平滑后的输出速度
        self._last_active = 0.0  # 最后一次有流量的时间

        self._pulse_on = False
        self._pulse_count = 0

        self._poll()
        self.root.mainloop()

    # ─── 鼠标事件 ─────────────────────────────────────
    def _on_click(self, event):
        self._drag_x = event.x
        self._drag_y = event.y
        self._dragged = False

    def _on_drag(self, event):
        self._dragged = True
        x = self.root.winfo_x() + event.x - self._drag_x
        y = self.root.winfo_y() + event.y - self._drag_y
        self.root.geometry(f"+{x}+{y}")

    def _on_release(self, event):
        if not self._dragged:
            self._open_dashboard()

    def _open_dashboard(self, event=None):
        monitor_dir = os.path.dirname(os.path.abspath(__file__))
        monitor_mjs = os.path.join(monitor_dir, "monitor.mjs")
        script = 'tell application "Terminal" to do script "node %s"' % monitor_mjs
        subprocess.Popen(
            ["osascript", "-e", script],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )

    def _quit(self, event=None):
        self.root.destroy()

    # ─── 轮询代理 ─────────────────────────────────────
    def _poll(self):
        try:
            req = urllib.request.Request(PROXY_URL)
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())

            totals = data.get("token_usage", {}).get("totals", {})
            cur_in = totals.get("input", 0) + totals.get("cache_read", 0)
            cur_out = totals.get("output", 0)

            now = time.time()

            if self._last_input >= 0 and self._last_time:
                dt = now - self._last_time
                if dt > 0:
                    raw_in_speed = (cur_in - self._last_input) / dt
                    raw_out_speed = (cur_out - self._last_output) / dt
                    # 指数平滑
                    self._smooth_in = SMOOTH_ALPHA * raw_in_speed + (1 - SMOOTH_ALPHA) * self._smooth_in
                    self._smooth_out = SMOOTH_ALPHA * raw_out_speed + (1 - SMOOTH_ALPHA) * self._smooth_out
                    # 记录活跃时间
                    if raw_in_speed > 1 or raw_out_speed > 1:
                        self._last_active = now

            self._last_input = cur_in
            self._last_output = cur_out
            self._last_time = now

            # 今日总量
            today_key = time.strftime("%Y-%m-%d")
            by_day = data.get("token_usage", {}).get("byDay", {})
            today = by_day.get(today_key, {}).get("total", 0)

            self._update(today)

        except Exception:
            self._show_error()

        self.root.after(POLL_SEC * 1000, self._poll)

    # ─── 更新显示 ─────────────────────────────────────
    def _update(self, today):
        idle_time = time.time() - self._last_active
        is_active = idle_time < 15  # 15 秒内有流量算活跃

        if is_active:
            in_str = self._fmt_speed(self._smooth_in)
            out_str = self._fmt_speed(self._smooth_out)
            self.canvas.itemconfig(self.in_text, text="↑" + in_str, fill=GREEN_IN)
            self.canvas.itemconfig(self.out_text, text="↓" + out_str, fill=BLUE_OUT)
            self.canvas.itemconfig(self.bg_circle, outline=BORDER_ON)
            if not self._pulse_on:
                self._pulse_on = True
                self._pulse()
        else:
            self.canvas.itemconfig(self.in_text, text="↑-", fill=DIM)
            self.canvas.itemconfig(self.out_text, text="↓-", fill=DIM)
            self.canvas.itemconfig(self.bg_circle, outline=BORDER_OFF)
            self._pulse_on = False
            # 缓慢衰减平滑值
            self._smooth_in *= 0.5
            self._smooth_out *= 0.5

        self.canvas.itemconfig(self.today_text, text=self._fmt(today))

    def _show_error(self):
        self.canvas.itemconfig(self.in_text, text="OFF", fill=RED)
        self.canvas.itemconfig(self.out_text, text="", fill=RED)
        self.canvas.itemconfig(self.bg_circle, outline=BORDER_ERR)
        self.canvas.itemconfig(self.today_text, text="")
        self._pulse_on = False

    def _pulse(self):
        if not self._pulse_on:
            self.canvas.itemconfig(self.bg_circle, outline=BORDER_OFF, width=2)
            return
        self._pulse_count = (self._pulse_count + 1) % 20
        alpha = 0.4 + 0.3 * math.sin(self._pulse_count * math.pi / 10)
        w = 2 + int(alpha * 2)
        self.canvas.itemconfig(self.bg_circle, outline=BORDER_ON, width=w)
        self.root.after(200, self._pulse)

    @staticmethod
    def _fmt(n):
        if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
        if n >= 1_000: return f"{n/1_000:.1f}K"
        return str(n)

    @staticmethod
    def _fmt_speed(tokens_per_sec):
        """格式化速度显示，K 为单位，1 位小数"""
        if tokens_per_sec >= 1_000_000:
            return f"{tokens_per_sec/1_000_000:.1f}M"
        if tokens_per_sec >= 1_000:
            return f"{tokens_per_sec/1_000:.1f}K"
        if tokens_per_sec >= 1:
            return f"{tokens_per_sec:.0f}"
        return "0"


if __name__ == "__main__":
    FloatingBall()
