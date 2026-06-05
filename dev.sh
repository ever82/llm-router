#!/bin/bash
set -e

cd "$(dirname "$0")"
CONFIG_FILE="./.issuetree/config.json"

read_port() {
  node -e "const cfg=require('$CONFIG_FILE'); const p=cfg.services.$1?.port; if(!p){console.error('No port for '+process.argv[1]);process.exit(1)}console.log(p)" "$1"
}

DEV_PORT=$(read_port proxy)

echo "llm-router proxy server"
echo "  Port: $DEV_PORT"

# Guard: already running
PID_DIR="/tmp/llm-router-dev-pids"
if [ -f "$PID_DIR" ]; then
  running=0
  for pid in $(cat "$PID_DIR" 2>/dev/null); do
    if kill -0 "$pid" 2>/dev/null; then running=$((running+1)); fi
  done
  if [ "$running" -gt 0 ]; then
    echo "Proxy server already running. Skipping start."
    exit 0
  fi
fi
rm -f "$PID_DIR"
mkdir -p "$(dirname "$PID_DIR")"

cleanup() {
  for pid in $(cat "$PID_DIR" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  rm -f "$PID_DIR"
}
trap cleanup EXIT INT TERM

echo "Project not yet initialized. Please customize this script."
echo "Expected proxy port: $DEV_PORT"
wait
