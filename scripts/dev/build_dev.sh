#!/bin/bash
# ZhiShi macOS Dev 构建脚本
# 构建带 DevTools 的调试版本，启动时自动打开控制台
# 只构建 .app 不构建 DMG (避免弹窗)

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 加载 .env 文件（如果存在）
if [ -f "${PROJECT_DIR}/.env" ]; then
    set -a  # 自动导出所有变量
    source "${PROJECT_DIR}/.env"
    set +a
fi

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🤖 ZhiShi macOS Dev 构建${NC}                           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${YELLOW}⚠ DevTools 启用 + 只构建 App${NC}                        ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# ========================================
# 版本同步检查
# ========================================
PKG_VERSION=$(grep '"version"' "${PROJECT_DIR}/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
CARGO_VERSION=$(grep '^version = ' "${PROJECT_DIR}/src-tauri/Cargo.toml" | head -1 | sed 's/version = "\([^"]*\)".*/\1/')

if [ "$PKG_VERSION" != "$TAURI_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
    echo -e "${YELLOW}⚠ 版本号不一致:${NC}"
    echo -e "  package.json:      ${CYAN}${PKG_VERSION}${NC}"
    echo -e "  tauri.conf.json:   ${CYAN}${TAURI_VERSION}${NC}"
    echo -e "  Cargo.toml:        ${CYAN}${CARGO_VERSION}${NC}"
    echo ""
    read -p "是否同步版本号到 ${PKG_VERSION}? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        node "${PROJECT_DIR}/scripts/sync-version.js"
        echo ""
    fi
fi

# 杀死残留 ZhiShi 实例（避免生产版和 debug 版同时运行互相打架）
# 优先使用 PID lock file 精确杀——只杀 ZhiShi 主进程，不误杀其他 bun 进程。
# SIGKILL(-9) 防止 macOS Automatic Termination 自动重启被杀的 .app。
echo -e "${BLUE}[准备] 杀死残留进程...${NC}"
LOCK_FILE="$HOME/.zhishi/app.lock"
if [ -f "$LOCK_FILE" ]; then
    OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    # Validate PID is a positive integer before using it with kill
    if [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo -e "${YELLOW}  杀死运行中的 ZhiShi (PID $OLD_PID)...${NC}"
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$LOCK_FILE"
fi
# Fallback: 杀死任何漏网的 ZhiShi 进程（lock file 可能不存在或 PID 已过期）
pkill -9 -f "ZhiShi.app" 2>/dev/null || true
pkill -9 -f "node.*src/server/index.ts" 2>/dev/null || true
pkill -9 -f "node.*server-dist.js" 2>/dev/null || true
sleep 1  # 等待进程完全退出
echo -e "${GREEN}✓ 进程已清理${NC}"
echo ""

# 清理旧构建（包括 Rust 缓存的 resources）
echo -e "${BLUE}[准备] 清理旧构建...${NC}"
rm -rf "${PROJECT_DIR}/dist"
# Tauri bundle 阶段需要 resources/ 下被引用的目录都存在（即使是空的——dev 模式
# 下 Rust 端会 fallback 到顶层 node_modules）。文件级 resource（server-dist.js
# / cli/zhishi.js）则由 tauri:build 的
# beforeBuildCommand 通过 `npm run build:server/cli` 在构建期间生成，
# 不需要额外占位文件。
# M4c: claude-agent-sdk 资源目录已删除。

# 填充 tsx-runtime（dev 模式 bridge.rs::find_tsx_runtime_loader 优先 fallback
# 到项目根 node_modules/tsx，但 Tauri bundler 仍要求资源目录存在；填一个最小
# 占位避免 cargo bundle 警告，prod build 才需要完整安装）。
mkdir -p "${PROJECT_DIR}/src-tauri/resources/tsx-runtime"
[ -f "${PROJECT_DIR}/src-tauri/resources/tsx-runtime/.dev-placeholder" ] || \
    echo "dev mode: tsx loads from top-level node_modules/tsx via find_tsx_runtime_loader fallback" \
    > "${PROJECT_DIR}/src-tauri/resources/tsx-runtime/.dev-placeholder"

# 确保 Node.js 运行时已下载且架构匹配当前主机。download_nodejs.sh 使用
# per-arch cache，resources/nodejs 只是当前 build 的 staging 目录。
NODEJS_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"
echo -e "${BLUE}[准备] 确保 Node.js 运行时匹配当前主机架构...${NC}"
"${PROJECT_DIR}/scripts/download_nodejs.sh"

# Rebuild native addons against bundled Node ABI (fixes ERR_DLOPEN_FAILED
# when system npm used a different Node.js version for initial install).
NODE_BIN="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/node"
if [ -x "$NODE_BIN" ]; then
    EXPECTED_ABI=$("$NODE_BIN" -p "process.versions.modules" 2>/dev/null)
    NATIVE_NODE="${PROJECT_DIR}/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    if [ -f "$NATIVE_NODE" ]; then
        # Check actual ABI by test-loading with bundled Node (cheap fail-fast)
        if ! "$NODE_BIN" -e "require('better-sqlite3')" 2>/dev/null; then
            echo -e "${CYAN}[预备] Rebuilding native addons for Node ABI ${EXPECTED_ABI}...${NC}"
            PATH="${PROJECT_DIR}/src-tauri/resources/nodejs/bin:$PATH" npm rebuild better-sqlite3
        fi
    fi
fi

# 清理 debug 构建产物（确保 resources 被重新复制）
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/bundle"
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/ZhiShi.app"
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/resources"
echo -e "${GREEN}✓ 已清理并创建占位符${NC}"
echo ""

# TypeScript 检查
echo -e "${BLUE}[1/3] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! npm run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败，请修复后重试${NC}"
    exit 1
fi
echo -e "${GREEN}✓ TypeScript 检查通过${NC}"
echo ""

# 前端 GUI 已删除（无窗口后台宿主形态）——跳过前端构建。
echo -e "${BLUE}[2/3] 前端已删除，跳过${NC}"
echo ""

# 强制触发 Rust 重新编译 (确保 sidecar.rs 的逻辑修改生效)
touch "${PROJECT_DIR}/src-tauri/src/sidecar.rs"
touch "${PROJECT_DIR}/src-tauri/src/main.rs"

# 构建 Tauri 应用
echo -e "${BLUE}[3/3] 构建 Tauri 应用 (Debug 模式, 仅 App)...${NC}"
# 强制移除旧的可执行文件，防止 cargo 偷懒不重新链接
rm -f "${PROJECT_DIR}/src-tauri/target/debug/app"

# 保留签名但禁用公证 (签名是必需的，否则 TCC 权限无法持久化)
# 参考: https://developer.apple.com/forums/thread/698337
# Ad hoc signing 会导致 TCC 无法正确追踪权限
unset APPLE_API_ISSUER
unset APPLE_API_KEY
unset APPLE_API_KEY_PATH
echo -e "${YELLOW}⚠ 已禁用 Apple 公证 (开发版，保留签名)${NC}"

# Node.js 已在前置准备阶段完成 staging；这里开始处理 SDK native binary。

# 拷贝 Claude Agent SDK native binary（按本机架构，debug app 运行时需要）
# 0.2.113+ 取代原 cli.js 分发模式
# M4c: Claude Agent SDK 已删除——dev 构建不再拷贝 claude binary。

# zhishi CLI 的打包不在这里——`npm run tauri:build` 的 beforeBuildCommand
# (tauri.conf.json) 已包含 `npm run build:cli`，由 `scripts/esbuild-bundle.mjs`
# 的 post-build hook 同步把 zhishi.cmd 拷贝到 resources/cli/。dev 脚本只需
# 保证目录存在，避免 Tauri bundle 阶段的 resource 校验报错。
mkdir -p "${PROJECT_DIR}/src-tauri/resources/cli"

# Debug 模式签名 (optional — ./scripts/build/build_macos.sh per-TARGET loop 已处理 Node + Claude)
# ./scripts/dev/build_dev.sh 只构建 host arch 单个，本段处理该情况下的 Node + Claude 签名。
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    NODE_BIN_DEV="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/node"
    if [ -f "$NODE_BIN_DEV" ]; then
        xattr -d com.apple.quarantine "$NODE_BIN_DEV" 2>/dev/null || true
        codesign --force --options runtime --timestamp \
            --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
            --sign "$APPLE_SIGNING_IDENTITY" "$NODE_BIN_DEV" 2>/dev/null || true
    fi
fi

echo -e "${YELLOW}这可能需要几分钟...${NC}"
# 如果没有设置 TAURI_SIGNING_PRIVATE_KEY，跳过签名错误
# (App 本身会正常构建，只是 updater 签名会失败)
if [ -z "${TAURI_SIGNING_PRIVATE_KEY}" ]; then
    echo -e "${YELLOW}⚠ 未设置 TAURI_SIGNING_PRIVATE_KEY，更新签名将被跳过${NC}"
    npm run tauri:build -- --debug --bundles app || true
else
    npm run tauri:build -- --debug --bundles app
fi

# 查找输出
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/debug/bundle"
APP_PATH=$(find "${BUNDLE_DIR}/macos" -name "*.app" 2>/dev/null | head -1)

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Dev 构建完成!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

if [ -n "$APP_PATH" ]; then
    APP_SIZE=$(du -sh "$APP_PATH" | cut -f1)
    echo -e "  ${CYAN}应用路径:${NC}"
    echo -e "    🍎 ${APP_PATH}"
    echo -e "    📏 大小: ${APP_SIZE}"
    echo ""
    echo -e "  ${CYAN}Dev 特性:${NC}"
    echo -e "    ✅ 启动时自动打开 DevTools"
    echo -e "    ✅ 宽松 CSP (允许 IPC)"
    echo -e "    ✅ 包含最新 server 代码"
    echo ""
else
    echo -e "  ${YELLOW}未找到构建产物，请检查上方输出${NC}"
fi

echo -e "  ${CYAN}运行方式:${NC}"
echo -e "    open \"$APP_PATH\""
echo ""
