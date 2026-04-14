#!/bin/bash
# LLM Proxy 停止脚本

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROXY_DIR/proxy.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    echo "✓ 代理已停止 (PID: $PID)"
  else
    rm -f "$PID_FILE"
    echo "代理进程已不存在，清理 PID 文件"
  fi
else
  echo "代理未在运行"
  # 尝试通过端口查找并杀掉
  PID=$(lsof -ti :4000 2>/dev/null)
  if [ -n "$PID" ]; then
    echo "发现端口 4000 上的进程: $PID"
    read -p "是否停止? [y/N] " answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
      kill $PID
      echo "✓ 已停止"
    fi
  fi
fi
