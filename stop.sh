#!/bin/bash
# LLM Proxy 停止脚本
# 同时停止 supervisor 和 proxy

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_PID_FILE="$PROXY_DIR/proxy.pid"
SUPERVISOR_PID_FILE="$PROXY_DIR/supervisor.pid"

stopped_something=0

# 先停 supervisor (防止它重启 proxy)
if [ -f "$SUPERVISOR_PID_FILE" ]; then
  SUP_PID=$(cat "$SUPERVISOR_PID_FILE")
  if kill -0 "$SUP_PID" 2>/dev/null; then
    kill -TERM "$SUP_PID"
    # 等 supervisor 优雅退出（trap 会清理 proxy）
    for i in 1 2 3 4 5; do
      kill -0 "$SUP_PID" 2>/dev/null || break
      sleep 0.3
    done
    if kill -0 "$SUP_PID" 2>/dev/null; then
      kill -KILL "$SUP_PID" 2>/dev/null
    fi
    echo "✓ Supervisor 已停止 (PID: $SUP_PID)"
    stopped_something=1
  fi
  rm -f "$SUPERVISOR_PID_FILE"
fi

# 再停 proxy（如果 supervisor 已经清理，这里会跳过）
if [ -f "$PROXY_PID_FILE" ]; then
  PID=$(cat "$PROXY_PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    echo "✓ 代理已停止 (PID: $PID)"
    stopped_something=1
  fi
  rm -f "$PROXY_PID_FILE"
fi

if [ "$stopped_something" = "0" ]; then
  echo "代理未在运行"
  # 尝试通过端口查找并杀掉
  for port in 4000 4001 4002 4003; do
    PID=$(lsof -ti :$port 2>/dev/null)
    if [ -n "$PID" ]; then
      echo "发现端口 $port 上的进程: $PID"
      read -p "是否停止? [y/N] " answer
      if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        kill $PID
        echo "✓ 已停止"
      fi
      break
    fi
  done
fi