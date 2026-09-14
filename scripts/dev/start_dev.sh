#!/bin/bash
# ZhiShi 开发启动脚本 (v0.2.0+)
#
# 不依赖 Bun。使用 bundled Node.js + tsx ESM loader 直跑 src/server/index.ts，
# 文件变动自动重启。（前端 GUI 已删除，仅启动后端 sidecar。）
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_AGENT_DIR="${PROJECT_DIR}"
PORT=3000

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🤖 ZhiShi 开发模式${NC}"
echo ""

AGENT_DIR="${1:-$DEFAULT_AGENT_DIR}"
echo -e "Agent 目录: ${GREEN}${AGENT_DIR}${NC}"
echo -e "后端端口: ${GREEN}${PORT}${NC}"
echo ""

# 定位 bundled Node.js（构建链路统一用这份；fallback 到系统 node 便于首次 clone）
NODE="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/node"
NPX="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/npx"
if [ ! -x "$NODE" ]; then
    echo -e "${YELLOW}  bundled Node.js 未下载（resources/nodejs/），回退到系统 node${NC}"
    NODE="$(command -v node || true)"
    NPX="$(command -v npx || true)"
fi
if [ -z "$NODE" ]; then
    echo -e "${RED}错误: 找不到 node（请运行 scripts/download_nodejs.sh 或装 Node.js ≥ 20）${NC}"
    exit 1
fi

# 清理上一轮的开发进程
cleanup() {
    echo ""
    echo -e "${YELLOW}正在停止服务...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    echo -e "${GREEN}已停止${NC}"
    exit 0
}
trap cleanup SIGINT SIGTERM

kill_existing() {
    echo -e "${YELLOW}检查并停止之前的开发服务...${NC}"

    local pid_3000=$(lsof -ti:3000 2>/dev/null)
    if [ -n "$pid_3000" ]; then
        echo -e "  停止端口 3000 上的进程: ${pid_3000}"
        kill -9 $pid_3000 2>/dev/null || true
    fi

    local LOCK_FILE="$HOME/.zhishi/app.lock"
    if [ -f "$LOCK_FILE" ]; then
        local OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
        if [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo -e "  停止 ZhiShi 桌面版 (PID $OLD_PID)..."
            kill -9 "$OLD_PID" 2>/dev/null || true
        fi
        rm -f "$LOCK_FILE"
    fi
    pkill -9 -f "ZhiShi.app" 2>/dev/null || true
    pkill -f "node.*src/server/index.ts" 2>/dev/null || true
    pkill -f "node.*server-dist.js" 2>/dev/null || true

    sleep 1
    echo -e "${GREEN}已清理之前的服务${NC}"
    echo ""
}
kill_existing

# 启动后端 Sidecar（tsx ESM loader 处理 TypeScript，--watch 文件变动自动重启）
echo -e "${BLUE}启动后端服务器...${NC}"
cd "${PROJECT_DIR}"
"$NODE" --import tsx/esm --watch \
    "${PROJECT_DIR}/src/server/index.ts" \
    --agent-dir "${AGENT_DIR}" --port ${PORT} &
BACKEND_PID=$!
echo -e "后端 PID: ${BACKEND_PID}"

sleep 2
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo -e "${RED}后端启动失败${NC}"
    exit 1
fi
echo -e "${GREEN}后端已启动: http://localhost:${PORT}${NC}"
echo ""

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}🎉 开发环境已就绪!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "后端: ${BLUE}http://localhost:${PORT}${NC}"
echo ""
echo -e "按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
echo ""

wait
