#!/bin/bash
# LLM Proxy 启动脚本
# 用法: ./start.sh          (前台运行)
#       ./start.sh bg       (后台运行)

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROXY_DIR/proxy.pid"
LOG_FILE="$PROXY_DIR/proxy.log"
PORT=4000

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "代理已在运行 (PID: $OLD_PID, 端口: $PORT)"
    echo "状态: curl http://localhost:$PORT/proxy-status"
    echo ""
    echo "如需重启，先运行: ./stop.sh"
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

# 检查端口是否被占用
if lsof -i :$PORT >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用:"
  lsof -i :$PORT
  echo ""
  echo "请先停止占用端口的进程，或修改 config.json 中的 port"
  exit 1
fi

if [ "$1" = "bg" ]; then
  # 后台运行
  nohup node "$PROXY_DIR/proxy.mjs" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo "✓ 代理已在后台启动 (PID: $(cat "$PID_FILE"), 端口: $PORT)"
    echo "  日志: tail -f $LOG_FILE"
    echo "  状态: curl http://localhost:$PORT/proxy-status"
    echo "  Token监控: llm-monitor"
    echo "  悬浮球: llm-ball"
    echo "  停止: ./stop.sh"
  else
    echo "✗ 启动失败，请查看日志: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
else
  # 前台运行
  node "$PROXY_DIR/proxy.mjs"
fi
