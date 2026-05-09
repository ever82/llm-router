#!/bin/bash
# LLM Proxy 启动脚本
# 用法: ./start.sh          (前台运行，无自动重启)
#       ./start.sh bg       (后台运行 + 自动重启 + 端口回退)
#
# 自动重启: 进程崩溃后自动重启，最多 5 次 / 5 分钟窗口，超出则停止
# 端口回退: config.json 端口被占用时自动尝试 4001/4002/4003

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_PID_FILE="$PROXY_DIR/proxy.pid"
SUPERVISOR_PID_FILE="$PROXY_DIR/supervisor.pid"
LOG_FILE="$PROXY_DIR/proxy.log"

CONFIG_PORT=$(node -e "
  try { console.log(require('$PROXY_DIR/config.json').port || 4000); }
  catch { console.log(4000); }
" 2>/dev/null)
PORT=${CONFIG_PORT:-4000}
FALLBACK_PORTS=(4001 4002 4003)
MAX_RESTARTS=5
RESTART_WINDOW=300

find_free_port() {
  local p=$1
  local candidates=("$p" "${FALLBACK_PORTS[@]}")
  for cand in "${candidates[@]}"; do
    if ! lsof -i :$cand >/dev/null 2>&1; then
      echo $cand
      return 0
    fi
  done
  return 1
}

# ─── supervisor 模式（内部使用，不应由用户直接调用）─────────────
if [ "$1" = "__supervisor" ]; then
  trap 'kill $(cat "$PROXY_PID_FILE" 2>/dev/null) 2>/dev/null; rm -f "$PROXY_PID_FILE" "$SUPERVISOR_PID_FILE"; exit 0' TERM INT

  restart_count=0
  window_start=$(date +%s)

  while true; do
    port=$(find_free_port $PORT)
    if [ -z "$port" ]; then
      echo "[$(date '+%F %T')] !!! 无可用端口 (尝试过 $PORT, ${FALLBACK_PORTS[*]})"
      rm -f "$SUPERVISOR_PID_FILE"
      exit 1
    fi

    echo "[$(date '+%F %T')] === 启动代理 (端口 $port) ==="
    PROXY_PORT=$port node --experimental-sqlite "$PROXY_DIR/proxy.mjs" &
    proxy_pid=$!
    echo $proxy_pid > "$PROXY_PID_FILE"

    wait $proxy_pid
    exit_code=$?

    rm -f "$PROXY_PID_FILE"
    echo "[$(date '+%F %T')] !!! 代理退出 (code=$exit_code)"

    # 滑动窗口统计
    now=$(date +%s)
    if [ $((now - window_start)) -ge $RESTART_WINDOW ]; then
      restart_count=0
      window_start=$now
    fi
    restart_count=$((restart_count + 1))

    if [ $restart_count -gt $MAX_RESTARTS ]; then
      echo "[$(date '+%F %T')] !!! 重启过于频繁 ($restart_count 次/${RESTART_WINDOW}s)，supervisor 退出"
      rm -f "$SUPERVISOR_PID_FILE"
      exit 1
    fi

    # 递增等待: 1, 2, 4, 8, 16 (capped)
    wait_time=$((2 ** (restart_count - 1)))
    [ $wait_time -gt 16 ] && wait_time=16
    echo "[$(date '+%F %T')] ${wait_time}s 后自动重启 ($restart_count/$MAX_RESTARTS)"
    sleep $wait_time
  done
fi

# ─── 检查是否已在运行 ──────────────────────────────
if [ -f "$SUPERVISOR_PID_FILE" ]; then
  SUP_PID=$(cat "$SUPERVISOR_PID_FILE")
  if kill -0 "$SUP_PID" 2>/dev/null; then
    echo "代理 supervisor 已在运行 (PID: $SUP_PID)"
    echo "状态: curl http://localhost:$PORT/proxy-status"
    echo "如需重启: ./stop.sh && ./start.sh bg"
    exit 0
  fi
  rm -f "$SUPERVISOR_PID_FILE"
fi

# ─── 后台模式: fork supervisor ─────────────────────
if [ "$1" = "bg" ]; then
  nohup "$0" __supervisor < /dev/null >> "$LOG_FILE" 2>&1 &
  SUP_PID=$!
  echo $SUP_PID > "$SUPERVISOR_PID_FILE"
  sleep 2

  if kill -0 $SUP_PID 2>/dev/null; then
    echo "✓ 代理已在后台启动"
    echo "  Supervisor PID: $SUP_PID"
    if [ -f "$PROXY_PID_FILE" ]; then
      echo "  Proxy PID: $(cat "$PROXY_PID_FILE")"
    fi
    echo "  端口: $PORT (端口回退: ${FALLBACK_PORTS[*]})"
    echo "  日志: tail -f $LOG_FILE"
    echo "  状态: curl http://localhost:$PORT/proxy-status"
    echo "  停止: ./stop.sh"
    echo "  自动重启: $MAX_RESTARTS 次/${RESTART_WINDOW}s 窗口"
  else
    rm -f "$SUPERVISOR_PID_FILE"
    echo "✗ 启动失败，请查看日志: $LOG_FILE"
    exit 1
  fi
else
  # 前台模式: 直接运行 (无 supervisor、无自动重启)
  exec node --experimental-sqlite "$PROXY_DIR/proxy.mjs"
fi