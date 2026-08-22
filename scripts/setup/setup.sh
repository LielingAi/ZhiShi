#!/bin/bash
# ZhiShi 开发环境初始化脚本
# 首次 clone 仓库后运行此脚本

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}  ${GREEN}🤖 ZhiShi 开发环境初始化${NC}              ${BLUE}║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
echo ""

# 检查依赖
check_install() {
    local name=$1
    local check_cmd=$2
    local install_hint=$3
    
    echo -n "  检查 $name... "
    if eval "$check_cmd" &> /dev/null; then
        echo -e "${GREEN}✓${NC}"
        return 0
    else
        echo -e "${RED}✗${NC}"
        echo -e "    ${YELLOW}请安装: $install_hint${NC}"
        return 1
    fi
}

echo -e "${BLUE}[1/5] 检查依赖${NC}"
MISSING=0

check_install "Node.js" "node --version" "https://nodejs.org (≥ v20)" || MISSING=1
check_install "npm" "npm --version" "随 Node.js 安装" || MISSING=1
check_install "Rust" "rustc --version" "https://rustup.rs" || MISSING=1
check_install "Cargo" "cargo --version" "随 Rust 安装" || MISSING=1

echo ""
if [ $MISSING -eq 1 ]; then
    echo -e "${RED}请先安装上述缺失的依赖，然后重新运行此脚本${NC}"
    exit 1
fi

# 下载 Node.js 二进制（Sidecar + MCP Server + 社区工具 统一 runtime）
echo ""
echo -e "${BLUE}[2/5] 下载 Node.js 运行时${NC}"
"${PROJECT_DIR}/scripts/download_nodejs.sh"
echo ""

# 安装依赖（使用 npm — v0.2.0 起不再依赖 Bun）
echo -e "${BLUE}[3/5] 安装依赖${NC}"
npm install
# Rebuild native addons (e.g. better-sqlite3) against bundled Node.js ABI —
# system `node` may differ in NODE_MODULE_VERSION and produce binaries that
# crash in our runtime with ERR_DLOPEN_FAILED.
NODE_BIN="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/node"
if [ -x "$NODE_BIN" ]; then
    echo -e "  ${CYAN}Rebuilding native addons against bundled Node...${NC}"
    PATH="${PROJECT_DIR}/src-tauri/resources/nodejs/bin:$PATH" npm rebuild
fi
echo -e "${GREEN}✓ 依赖安装完成${NC}"
echo ""

# 安装 Rust 依赖
echo -e "${BLUE}[4/5] 检查 Rust 依赖${NC}"
cd src-tauri
cargo check --quiet 2>/dev/null || cargo fetch
cd ..
echo -e "${GREEN}✓ Rust 依赖准备完成${NC}"
echo ""

# 准备默认工作区 (novo)
# .git 不保留：避免 Tauri 资源打包权限问题 + rerun-if-changed 性能问题
echo -e "${BLUE}[5/5] 准备默认工作区 (novo)${NC}"
NOVO_DIR="${PROJECT_DIR}/novo"
if [ ! -d "$NOVO_DIR" ] || [ ! -f "$NOVO_DIR/CLAUDE.md" ]; then
    echo -e "${RED}错误: novo/ 目录不存在或不完整!${NC}"
    exit 1
fi
rm -rf "$NOVO_DIR/.git"
echo -e "${GREEN}✓ novo 默认工作区已就绪${NC}"
echo ""

# 完成
echo -e "${BLUE}✓ 初始化完成!${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  开发环境准备就绪!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  后续步骤:"
echo ""
echo "  ${BLUE}开发模式:${NC}"
echo "    ./scripts/dev/start_dev.sh"
echo ""
echo "  ${BLUE}运行 Tauri 应用:${NC}"
echo "    npm run tauri:dev"
echo ""
echo "  ${BLUE}构建 macOS 安装包:${NC}"
echo "    ./scripts/build/build_macos.sh"
echo ""
