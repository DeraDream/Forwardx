#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)

if ! command -v go >/dev/null 2>&1; then
    echo "未找到 Go，请先执行: brew install go"
    exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
    echo "未找到 pnpm，请先执行: brew install node && corepack enable"
    exit 1
fi

cleanup() {
    if [ -n "${BACKEND_PID:-}" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

cd "$ROOT_DIR"
go run . &
BACKEND_PID=$!

cd "$ROOT_DIR/webs"
if [ ! -d node_modules ]; then
    HUSKY=0 pnpm install --no-frozen-lockfile
fi

echo "SublinkX 本地开发地址: http://127.0.0.1:3000"
echo "默认账号: admin / 123456"
pnpm dev
