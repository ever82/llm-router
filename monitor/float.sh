#!/bin/bash
# Token桌面悬浮球 - 跨平台启动
# macOS -> Swift (真圆透明)
# Windows/Linux -> Python/Tkinter

os=$(uname -s)
case "$os" in
  Darwin)
    exec "$HOME/manage/llm-proxy/monitor/BallApp"
    ;;
  *)
    python3 "$HOME/manage/llm-proxy/monitor/ball.py"
    ;;
esac
