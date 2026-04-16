#!/bin/bash
# Token桌面悬浮球 - 跨平台启动
# macOS -> Swift (真圆透明)
# Windows/Linux -> Python/Tkinter

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

os=$(uname -s)
case "$os" in
  Darwin)
    exec "$SCRIPT_DIR/BallApp"
    ;;
  *)
    python3 "$SCRIPT_DIR/ball.py"
    ;;
esac
