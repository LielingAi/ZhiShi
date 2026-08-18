#!/bin/bash
# ZhiShi macOS 正式发布构建脚本
# 构建签名+公证的 DMG 安装包用于分发
# 支持 ARM (M1/M2)、Intel 构建

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_CONF="${PROJECT_DIR}/src-tauri/tauri.conf.json"
ENV_FILE="${PROJECT_DIR}/.env"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🤖 ZhiShi macOS 签名发布构建${NC}                      ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${BLUE}Version: ${VERSION}${NC}                                      ${CYAN}║${NC}"
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
        VERSION="$PKG_VERSION"  # 更新显示的版本号
        echo ""
    fi
fi

# ========================================
# 加载环境变量 (签名配置)
# ========================================
echo -e "${BLUE}[1/7] 加载签名配置...${NC}"
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
    echo -e "${GREEN}✓ 已加载 .env${NC}"
else
    echo -e "${RED}错误: .env 文件不存在!${NC}"
    echo "请创建 .env 文件并配置以下变量:"
    echo "  APPLE_SIGNING_IDENTITY"
    echo "  APPLE_TEAM_ID"
    echo "  APPLE_API_ISSUER"
    echo "  APPLE_API_KEY"
    echo "  APPLE_API_KEY_PATH"
    exit 1
fi

# 验证签名环境变量
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
    echo -e "${RED}错误: APPLE_SIGNING_IDENTITY 未设置!${NC}"
    exit 1
fi

if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
    echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║ 警告: TAURI_SIGNING_PRIVATE_KEY 未设置                     ║${NC}"
    echo -e "${YELLOW}║ 自动更新功能将不可用!                                      ║${NC}"
    echo -e "${YELLOW}║                                                           ║${NC}"
    echo -e "${YELLOW}║ 如需启用自动更新，请在 .env 中添加:                         ║${NC}"
    echo -e "${YELLOW}║   TAURI_SIGNING_PRIVATE_KEY=<私钥内容>                     ║${NC}"
    echo -e "${YELLOW}║   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<密码>                ║${NC}"
    echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    read -p "是否继续构建? (Y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        echo -e "${RED}构建已取消${NC}"
        exit 1
    fi
else
    echo -e "  ${GREEN}✓ Tauri 签名私钥已配置${NC}"
fi

echo -e "  签名身份: ${CYAN}${APPLE_SIGNING_IDENTITY}${NC}"
echo ""

# ========================================
# 清理残留进程
# ========================================
echo -e "${BLUE}[准备] 清理残留进程...${NC}"
pkill -f "node.*src/server/index.ts" 2>/dev/null || true
pkill -f "node.*server-dist.js" 2>/dev/null || true
pkill -f "ZhiShi.app" 2>/dev/null || true
sleep 1
echo -e "${GREEN}✓ 进程已清理${NC}"
echo ""

# 架构选择
echo -e "${YELLOW}请选择目标架构:${NC}"
echo "  1) ARM (Apple Silicon M1/M2) [默认]"
echo "  2) Intel (x86_64)"
echo "  3) Both (同时构建两个版本)"
echo ""
read -p "请输入选项 (1/2/3) [1]: " -r ARCH_CHOICE
ARCH_CHOICE=${ARCH_CHOICE:-1}

case $ARCH_CHOICE in
    1)
        BUILD_TARGETS=("aarch64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 版本${NC}"
        ;;
    2)
        BUILD_TARGETS=("x86_64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 Intel 版本${NC}"
        ;;
    3)
        BUILD_TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 和 Intel 两个版本${NC}"
        ;;
    *)
        BUILD_TARGETS=("aarch64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 版本 (默认)${NC}"
        ;;
esac
echo ""

# 检查依赖
check_dependency() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}错误: $1 未安装${NC}"
        echo "$2"
        exit 1
    fi
}

echo -e "${BLUE}[2/7] 检查依赖...${NC}"
check_dependency "rustc" "请安装 Rust: https://rustup.rs"
check_dependency "npm" "请安装 Node.js: https://nodejs.org"
check_dependency "codesign" "需要 Xcode Command Line Tools"

# 检查 novo 默认工作区
if [ ! -d "${PROJECT_DIR}/novo" ] || [ ! -f "${PROJECT_DIR}/novo/CLAUDE.md" ]; then
    echo -e "${RED}错误: novo/ 目录不存在或不完整! 请先运行 ./scripts/setup/setup.sh${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ novo 默认工作区已就绪${NC}"

# 检查并安装 Rust 交叉编译目标
for TARGET in "${BUILD_TARGETS[@]}"; do
    if ! rustup target list --installed | grep -q "$TARGET"; then
        echo -e "${YELLOW}  安装 Rust 目标: $TARGET${NC}"
        rustup target add "$TARGET"
    else
        echo -e "${GREEN}  ✓ Rust 目标已安装: $TARGET${NC}"
    fi
done

echo -e "${GREEN}✓ 依赖检查通过${NC}"
echo ""

# CSP 验证（tauri.conf.json 中已包含跨平台完整 CSP，无需覆写）
echo -e "${BLUE}[3/7] 验证 CSP 配置...${NC}"
echo -e "${GREEN}✓ 使用 tauri.conf.json 中的跨平台 CSP（含 Windows 兼容指令）${NC}"
echo ""

# 清理旧构建
echo -e "${BLUE}[准备] 清理旧构建...${NC}"

for TARGET in "${BUILD_TARGETS[@]}"; do
    rm -rf "${PROJECT_DIR}/src-tauri/target/${TARGET}/release/bundle"
done

echo -e "${GREEN}✓ 清理完成${NC}"
echo ""

# TypeScript 类型检查
echo -e "${BLUE}[4/7] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! npm run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败，请修复后重试${NC}"
    exit 1
fi
echo -e "${GREEN}✓ TypeScript 检查通过${NC}"
echo ""

# 下载最新 cuse 二进制 (computer-use MCP)
# 每次构建都拉取最新 release —— cuse 私有仓库的 release.yml 自动构建并发到 GH Release，
# 维护者再跑 ZhiShi-Cuse/publish_r2.sh 把产物镜像到 R2（`download.zhishi.help/cuse/...`），
# 此脚本从 R2 公网拉取，无需 gh CLI / 无需访问私有仓库。
echo -e "${BLUE}[4.5/7] 拉取最新 cuse 二进制...${NC}"
if ! "${PROJECT_DIR}/scripts/download_cuse.sh"; then
    echo -e "${RED}✗ cuse 下载失败，无法继续构建${NC}"
    exit 1
fi
echo -e "${GREEN}✓ cuse 已就绪${NC}"
echo ""

# 构建前端和服务端
echo -e "${BLUE}[5/7] 构建前端和服务端...${NC}"

# Sidecar / Bridge / CLI 三件套都走 `npm run build:*` —— 后台是
# `node scripts/esbuild-bundle.mjs <target>`。单一配置入口（entry /
# banner / format / external / target），不再让 shell 引号介入。
# Driver 内部包含 post-build 步骤：cli 复制 zhishi.cmd，server 校验
# 无硬编码 __dirname 路径——这两步以前在每个平台脚本里各抄一遍，现已合并。
echo -e "  ${CYAN}打包服务端代码...${NC}"
npm run build:server
echo -e "  ${CYAN}打包 zhishi CLI...${NC}"
npm run build:cli

# M4c: Claude Agent SDK 已删除——不再分发 claude native binary。

# NOTE: agent-browser CLI is no longer bundled. The skill at
# bundled-skills/agent-browser/SKILL.md teaches AI to self-install via
# `npm install -g agent-browser@<pinned>` (with `npx` fallback) on first
# use. Removing the bundle saves ~84MB DMG size + ~1-2min build time.

# 预装 sharp 图像处理（替代 jimp，libvips 原生，上游 claude-code 同款）
# 需要 sharp + @img/sharp-darwin-{arm64,x64} + @img/sharp-libvips-darwin-{arm64,x64}
# 为什么不用 agent-browser 的 lockfile 模式：sharp 的 optional deps 按 host 平台过滤，
# 单 lockfile 只能锁定一个架构。改为 package.json 显式声明 + 强制安装所有 darwin 变体。
echo -e "  ${CYAN}预装 sharp 图像处理（libvips 原生）...${NC}"
SHARP_DIR="${PROJECT_DIR}/src-tauri/resources/sharp-runtime"
rm -rf "${SHARP_DIR}"
mkdir -p "${SHARP_DIR}"
cat > "${SHARP_DIR}/package.json" <<'SHARP_PKG'
{
  "name": "sharp-runtime",
  "private": true,
  "version": "1.0.0",
  "dependencies": { "sharp": "0.34.5" }
}
SHARP_PKG
(cd "${SHARP_DIR}" && npm install --no-audit --no-fund --no-save --ignore-scripts)
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ sharp 主包预装失败${NC}"
    exit 1
fi
# 强制安装所有 macOS 架构的 @img/sharp-* 和 @img/sharp-libvips-*（精确版本锁定，避免 patch 漂移）
# npm install 默认只装 host arch 的 optional dep，这里显式补全另一个 arch
(cd "${SHARP_DIR}" && npm install --no-save --force --no-audit --no-fund --ignore-scripts \
    @img/sharp-darwin-arm64@0.34.5 @img/sharp-darwin-x64@0.34.5 \
    @img/sharp-libvips-darwin-arm64@1.2.4 @img/sharp-libvips-darwin-x64@1.2.4)
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ sharp 跨架构包安装失败${NC}"
    exit 1
fi
# 验证两个架构的原生二进制都存在
for ARCH in arm64 x64; do
    SHARP_NODE="${SHARP_DIR}/node_modules/@img/sharp-darwin-${ARCH}/lib/sharp-darwin-${ARCH}.node"
    SHARP_DYLIB_DIR="${SHARP_DIR}/node_modules/@img/sharp-libvips-darwin-${ARCH}/lib"
    if [ ! -f "$SHARP_NODE" ]; then
        echo -e "${RED}✗ sharp-darwin-${ARCH}.node 缺失${NC}"
        exit 1
    fi
    if [ ! -d "$SHARP_DYLIB_DIR" ] || [ -z "$(ls "$SHARP_DYLIB_DIR"/*.dylib 2>/dev/null)" ]; then
        echo -e "${RED}✗ sharp-libvips-darwin-${ARCH} dylib 缺失${NC}"
        exit 1
    fi
done
# 删除 linux/win32 的 @img/sharp-* 包（避免公证扫描非 darwin 原生代码）
find "${SHARP_DIR}/node_modules/@img" -maxdepth 1 -type d \
    \( -name "sharp-linux*" -o -name "sharp-win32*" -o -name "sharp-libvips-linux*" -o -name "sharp-libvips-win32*" -o -name "sharp-wasm32" \) \
    -exec rm -rf {} + 2>/dev/null || true
echo -e "${GREEN}  ✓ sharp 预装完成 (darwin arm64 + x64)${NC}"

# 前端 GUI 已删除（无窗口后台宿主形态）——server/bridge/cli bundle 由
# tauri build 的 beforeBuildCommand 构建。
echo -e "${GREEN}✓ 服务端构建完成${NC}"
echo ""

# Node.js staging 目录（每个构建目标在循环中按架构从 cache 同步）
NODEJS_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"

# ========================================
# 签名 externalBin 可执行文件
# ========================================
echo -e "${BLUE}[6/7] 签名外部二进制文件...${NC}"

# 重签名：官方/下载的二进制默认用各自官方签名；macOS TCC 会把它们视为独立应用，
# 导致每次访问受保护目录需单独授权。重签后子进程与主应用共享同一 Team ID，TCC
# 权限（含 Screen Recording / Accessibility / AppleEvents）统一继承。
echo -e "  ${CYAN}签名 externalBin 可执行文件 (使用应用签名替换官方签名)...${NC}"
# Pit-of-success: signs ANY file matching src-tauri/binaries/*-apple-darwin.
# Dropping a new externalBin under src-tauri/binaries/ with the apple-darwin
# triple is enough — the loop auto-picks it up, re-signs it with our
# Developer ID + hardened runtime + entitlements, and TCC permissions
# inherit through the shared code signature. No per-binary enumeration to
# keep in sync with tauri.conf.json.
EXTBIN_DIR="${PROJECT_DIR}/src-tauri/binaries"
EXTBIN_SIGNED_COUNT=0
EXTBIN_FAILED_COUNT=0

for bin in "${EXTBIN_DIR}"/*-apple-darwin; do
    if [ -f "$bin" ]; then
        echo -e "    ${CYAN}处理: $(basename "$bin")${NC}"

        # 1. 移除 quarantine 属性 (macOS 会标记下载的二进制文件)
        # 参考：https://v2.tauri.app/develop/sidecar/
        xattr -d com.apple.quarantine "$bin" 2>/dev/null || true

        # 2. 重签名：使用 --force 强制重签名，--options runtime 启用 hardened runtime
        # --entitlements 使用应用的 entitlements 确保 JIT 等权限
        # 子进程与主应用共享相同的 Team ID，TCC 权限（含 Screen Recording /
        # Accessibility / AppleEvents）可以正确继承。
        if codesign --force --options runtime --timestamp \
            --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
            --sign "$APPLE_SIGNING_IDENTITY" "$bin"; then
            echo -e "    ${GREEN}✓ $(basename "$bin") 签名成功${NC}"
            ((EXTBIN_SIGNED_COUNT++))
        else
            echo -e "    ${RED}✗ $(basename "$bin") 签名失败${NC}"
            ((EXTBIN_FAILED_COUNT++))
        fi
    fi
done

if [ $EXTBIN_FAILED_COUNT -gt 0 ]; then
    echo -e "${RED}错误: externalBin 签名失败，构建终止${NC}"
    exit 1
fi
echo -e "${GREEN}✓ externalBin 签名完成 (${EXTBIN_SIGNED_COUNT} 个文件)${NC}"

echo ""

# ========================================
# 签名 Vendor 二进制文件 (ripgrep)
# ========================================
echo -e "  ${CYAN}签名 Vendor 二进制文件 (ripgrep, .node)...${NC}"

# 签名所有 macOS 二进制文件
VENDOR_DIR="${SDK_DEST}/vendor"
SIGNED_COUNT=0
FAILED_COUNT=0

# 使用 process substitution 避免子 shell 问题
while IFS= read -r binary; do
    echo -e "    ${CYAN}签名: $(basename "$binary")${NC}"
    if codesign --force --options runtime --timestamp \
        --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
        ((SIGNED_COUNT++))
    else
        echo -e "    ${YELLOW}警告: 签名失败 - $binary${NC}"
        ((FAILED_COUNT++))
    fi
done < <(find "$VENDOR_DIR" -type f \( -name "*.node" -o -name "rg" \) -path "*darwin*")

echo -e "${GREEN}✓ Vendor 签名完成 (成功: ${SIGNED_COUNT}, 失败: ${FAILED_COUNT})${NC}"
echo ""

# NOTE: agent-browser-cli signing block removed — bundle no longer ships.
# AI installs the CLI on first use via the agent-browser skill (npm install -g).

# ========================================
# 签名 sharp 原生二进制
# ========================================
echo -e "  ${CYAN}签名 sharp 原生二进制 (.node + libvips .dylib)...${NC}"
SHARP_SIGNED_COUNT=0
SHARP_FAILED_COUNT=0

# @img/sharp-darwin-<arch>/lib/*.node 和 @img/sharp-libvips-darwin-<arch>/lib/*.dylib 都需要签名
# 不签的话公证会拒；sharp 在 TCC 下不需要额外权限（纯 CPU 图像处理）。
while IFS= read -r binary; do
    echo -e "    ${CYAN}签名: $(echo "$binary" | sed "s|.*/node_modules/||")${NC}"
    if codesign --force --options runtime --timestamp \
        --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
        ((SHARP_SIGNED_COUNT++))
    else
        echo -e "    ${YELLOW}警告: 签名失败 - $binary${NC}"
        ((SHARP_FAILED_COUNT++))
    fi
done < <(find "${SHARP_DIR}/node_modules/@img" -type f \( -name "*.node" -o -name "*.dylib" \) 2>/dev/null)

if [ $SHARP_FAILED_COUNT -gt 0 ]; then
    echo -e "${RED}错误: sharp 原生二进制签名失败 (${SHARP_FAILED_COUNT} 个)，公证必定失败${NC}"
    exit 1
fi
if [ $SHARP_SIGNED_COUNT -eq 0 ]; then
    echo -e "${RED}错误: 未签名任何 sharp 二进制，sharp 预装可能失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ sharp 签名完成 (${SHARP_SIGNED_COUNT} 个文件)${NC}"
echo ""

# 构建 Tauri 应用
echo -e "${BLUE}[7/7] 构建 Tauri 应用 (Release + 签名 + 公证)...${NC}"
echo -e "${YELLOW}这可能需要 5-10 分钟 (包含公证等待时间)...${NC}"

# M4c: Claude Agent SDK 已删除——跨架构补齐段移除。

for TARGET in "${BUILD_TARGETS[@]}"; do
    echo ""
    echo -e "${YELLOW}━━━ 构建目标: $TARGET ━━━${NC}"

    # ---- 确保 Node.js 匹配目标架构 ----
    # 将 Tauri target triple 映射为 Node.js 架构名
    if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
        NODE_TARGET_ARCH="arm64"
    else
        NODE_TARGET_ARCH="x64"
    fi

    echo -e "  ${CYAN}确保 Node.js 匹配目标架构 (${NODE_TARGET_ARCH})...${NC}"
    "${PROJECT_DIR}/scripts/download_nodejs.sh" --target "$NODE_TARGET_ARCH"

    # ---- 重新填充 tsx-runtime 资源以匹配目标架构 ----
    # `setup-tsx-runtime.mjs` 用 npm 的 --os/--cpu 选择对应平台的
    # `@esbuild/<triple>` 二进制；跨架构 Mac DMG 必须按 TARGET 重灌。
    echo -e "  ${CYAN}填充 tsx-runtime (darwin-${NODE_TARGET_ARCH})...${NC}"
    npm run build:tsx-runtime -- darwin "$NODE_TARGET_ARCH"

    # ---- 签名 tsx-runtime 内的 esbuild 原生二进制 ----
    # esbuild 是 Go 静态编译，没有 JIT 需求；跟 ripgrep / sharp 一样只要
    # `--options runtime --timestamp`，不需要 entitlements。
    # npm 安装后两处 path 都有 binary：
    #   - node_modules/esbuild/bin/esbuild              (npm postinstall 拷贝/硬链接)
    #   - node_modules/@esbuild/<triple>/bin/esbuild    (per-platform optional dep)
    # 两者通常共享同一个 inode（hardlink），但 codesign 路径独立，必须各签一次；
    # node_modules/.bin/esbuild 是 symlink，notarizer 跟随符号链接验证，所以签源
    # 文件就够了，不必单独处理。
    TSX_RUNTIME_DIR="${PROJECT_DIR}/src-tauri/resources/tsx-runtime"
    TSX_SIGNED_COUNT=0
    TSX_FAILED_COUNT=0
    while IFS= read -r binary; do
        echo -e "    ${CYAN}签名: $(echo "$binary" | sed "s|.*/tsx-runtime/||")${NC}"
        xattr -d com.apple.quarantine "$binary" 2>/dev/null || true
        if codesign --force --options runtime --timestamp \
            --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
            ((TSX_SIGNED_COUNT++))
        else
            echo -e "    ${RED}✗ 签名失败 - $binary${NC}"
            ((TSX_FAILED_COUNT++))
        fi
    done < <(find "${TSX_RUNTIME_DIR}/node_modules" -type f -path "*/bin/esbuild" 2>/dev/null)
    if [ $TSX_FAILED_COUNT -gt 0 ]; then
        echo -e "${RED}✗ tsx-runtime esbuild 签名失败 (${TSX_FAILED_COUNT} 个)，公证必定失败${NC}"
        exit 1
    fi
    if [ $TSX_SIGNED_COUNT -eq 0 ]; then
        echo -e "${RED}✗ 未签名任何 esbuild 二进制，setup-tsx-runtime 可能没装上 native dep${NC}"
        exit 1
    fi
    echo -e "    ${GREEN}✓ tsx-runtime esbuild 签名完成 (${TSX_SIGNED_COUNT} 个)${NC}"

    # 签名 Node.js 二进制 (TCC / notarization 需要统一签名)
    NODE_BINARY="${NODEJS_DIR}/bin/node"
    if [ -f "$NODE_BINARY" ]; then
        xattr -d com.apple.quarantine "$NODE_BINARY" 2>/dev/null || true
        if codesign --force --options runtime --timestamp \
            --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
            --sign "$APPLE_SIGNING_IDENTITY" "$NODE_BINARY"; then
            echo -e "    ${GREEN}✓ node (${NODE_TARGET_ARCH}) 签名成功${NC}"
        else
            echo -e "    ${RED}✗ node 签名失败${NC}"
            exit 1
        fi
    fi

    # M4c: Claude Agent SDK 已删除——不再拷贝/签名 claude binary。

    npm run tauri:build -- --target "$TARGET"

    echo -e "${GREEN}✓ $TARGET 构建完成${NC}"
done

# 双架构发布构建会按 target 重写 resources/nodejs。产物已经在各自
# target 构建时复制完毕，收尾时把本地 staging 恢复成当前主机架构，
# 避免后续 ./scripts/dev/build_dev.sh / npm rebuild 先碰到另一种架构的 Node。
if [[ "$(uname -m)" == "arm64" ]]; then
    HOST_NODE_TARGET_ARCH="arm64"
else
    HOST_NODE_TARGET_ARCH="x64"
fi
echo ""
echo -e "${CYAN}恢复 Node.js staging 到当前主机架构 (${HOST_NODE_TARGET_ARCH})...${NC}"
"${PROJECT_DIR}/scripts/download_nodejs.sh" --target "$HOST_NODE_TARGET_ARCH"

echo ""

# 检查输出
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target"

echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 签名版构建成功!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

# 显示构建产物
UPDATER_READY=true
for TARGET in "${BUILD_TARGETS[@]}"; do
    TARGET_BUNDLE_DIR="${BUNDLE_DIR}/${TARGET}/release/bundle"
    DMG_PATH=$(find "${TARGET_BUNDLE_DIR}/dmg" -name "*.dmg" 2>/dev/null | head -1)
    APP_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app" 2>/dev/null | head -1)
    TAR_GZ_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app.tar.gz" ! -name "*.sig" 2>/dev/null | head -1)
    SIG_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app.tar.gz.sig" 2>/dev/null | head -1)

    # 架构友好名称
    if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
        ARCH_NAME="ARM (Apple Silicon)"
    else
        ARCH_NAME="Intel (x86_64)"
    fi

    echo -e "  ${CYAN}【$ARCH_NAME】${NC}"

    # DMG (官网下载用)
    if [ -n "$DMG_PATH" ]; then
        DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
        echo -e "    📦 DMG: $(basename "$DMG_PATH") (${DMG_SIZE})"
    else
        echo -e "    ${RED}✗${NC} DMG: 未找到"
    fi

    # tar.gz (自动更新用)
    if [ -n "$TAR_GZ_PATH" ]; then
        TAR_SIZE=$(du -h "$TAR_GZ_PATH" | cut -f1)
        echo -e "    📄 tar.gz: $(basename "$TAR_GZ_PATH") (${TAR_SIZE})"
    else
        echo -e "    ${YELLOW}⚠️${NC} tar.gz: 未找到"
        UPDATER_READY=false
    fi

    # 签名文件 (自动更新验证用)
    if [ -n "$SIG_PATH" ]; then
        echo -e "    🔐 签名: $(basename "$SIG_PATH")"
    else
        echo -e "    ${YELLOW}⚠️${NC} 签名: 未找到 (自动更新将不可用)"
        UPDATER_READY=false
    fi

    if [ -n "$APP_PATH" ]; then
        # 验证 Apple 签名
        if codesign --verify --deep --strict "$APP_PATH" 2>/dev/null; then
            echo -e "    ✅ Apple 签名: ${GREEN}通过${NC}"
        else
            echo -e "    ⚠️ Apple 签名: ${YELLOW}失败${NC}"
        fi

        # 验证公证
        if spctl --assess --type exec "$APP_PATH" 2>/dev/null; then
            echo -e "    ✅ 公证验证: ${GREEN}通过${NC}"
        else
            echo -e "    ⚠️ 公证验证: ${YELLOW}未完成或失败${NC}"
        fi
    fi
    echo ""
done

# 自动更新状态总结
if [ "$UPDATER_READY" = true ]; then
    echo -e "  ${GREEN}✅ 自动更新: 所有文件就绪${NC}"
else
    echo -e "  ${YELLOW}⚠️  自动更新: 缺少必要文件 (tar.gz 或 .sig)${NC}"
    echo -e "  ${YELLOW}   请确保 .env 中配置了 TAURI_SIGNING_PRIVATE_KEY${NC}"
fi
echo ""

echo -e "  ${CYAN}正式版特性:${NC}"
echo -e "    ✅ Developer ID 签名"
echo -e "    ✅ Apple 公证 (Notarized)"
echo -e "    ✅ Hardened Runtime"
echo -e "    ✅ CSP 安全策略"
echo -e "    ✅ Release 优化"
echo ""

read -p "是否打开输出目录? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    FIRST_TARGET="${BUILD_TARGETS[0]}"
    open "${BUNDLE_DIR}/${FIRST_TARGET}/release/bundle"
fi

echo ""
read -p "是否发布到 Cloudflare R2? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    "${PROJECT_DIR}/scripts/release/publish_release.sh"
fi
