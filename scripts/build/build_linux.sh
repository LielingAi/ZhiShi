#!/bin/bash
# ZhiShi Linux 构建脚本 (v0.2.0+)
#
# 产出 AppImage + deb 到 src-tauri/target/release/bundle/{appimage,deb}。
# 所需系统依赖（Ubuntu 22.04+ / Debian 12+）：
#   sudo apt-get install -y \
#     build-essential libssl-dev libgtk-3-dev libayatana-appindicator3-dev \
#     librsvg2-dev libwebkit2gtk-4.1-dev patchelf
# (详见 specs/tech_docs/linux_platform_guide.md)

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -f "${PROJECT_DIR}/.env" ]; then
    set -a
    source "${PROJECT_DIR}/.env"
    set +a
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🤖 ZhiShi Linux 构建 (AppImage + deb)${NC}            ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# 版本一致性
PKG_VERSION=$(grep '"version"' "${PROJECT_DIR}/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
CARGO_VERSION=$(grep '^version = ' "${PROJECT_DIR}/src-tauri/Cargo.toml" | head -1 | sed 's/version = "\([^"]*\)".*/\1/')
if [ "$PKG_VERSION" != "$TAURI_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
    echo -e "${YELLOW}⚠ 版本号不一致，请先运行 \`node scripts/sync-version.js\`${NC}"
    exit 1
fi
echo -e "${BLUE}[信息] 构建版本: ${PKG_VERSION}${NC}"
echo ""

# 依赖检查（仅 Debian/Ubuntu 通过 dpkg 精确校验；其它发行版跳过 + 提示等价包名）
echo -e "${BLUE}[1/5] 检查系统依赖...${NC}"
if command -v dpkg >/dev/null 2>&1; then
    # Ubuntu 版本 gate: 22.04+ 才有 libwebkit2gtk-4.1；20.04 仍停留在 4.0
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        if [ "${ID:-}" = "ubuntu" ] && [ -n "${VERSION_ID:-}" ]; then
            major=$(echo "$VERSION_ID" | cut -d. -f1)
            if [ "${major:-0}" -lt 22 ] 2>/dev/null; then
                echo -e "${YELLOW}⚠ 检测到 Ubuntu ${VERSION_ID}。ZhiShi 需要 Ubuntu 22.04+ (libwebkit2gtk-4.1)。${NC}"
                echo -e "${YELLOW}  20.04 仍使用 libwebkit2gtk-4.0，Tauri 2 不支持。升级系统或使用 22.04+ 构建机。${NC}"
                exit 1
            fi
        fi
    fi

    missing=()
    for pkg in pkg-config libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev patchelf; do
        if ! dpkg -s "$pkg" >/dev/null 2>&1; then
            missing+=("$pkg")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}缺少系统依赖 (Debian/Ubuntu):${NC} ${missing[*]}"
        echo -e "${YELLOW}运行: sudo apt-get install -y ${missing[*]}${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ 系统依赖齐全 (Debian/Ubuntu)${NC}"
else
    echo -e "${YELLOW}⚠ 未检测到 dpkg (非 Debian/Ubuntu 发行版)${NC}"
    echo -e "${YELLOW}  请确保已安装: pkg-config, openssl-devel/libssl-dev, gtk3-devel/libgtk-3-dev,${NC}"
    echo -e "${YELLOW}    libayatana-appindicator-devel/libayatana-appindicator3-dev,${NC}"
    echo -e "${YELLOW}    librsvg2-devel/librsvg2-dev, webkit2gtk4.1-devel/libwebkit2gtk-4.1-dev,${NC}"
    echo -e "${YELLOW}    patchelf${NC}"
    echo -e "${YELLOW}  Tauri 构建如缺库会给出明确错误。继续...${NC}"
fi
echo ""

# TypeScript 检查
echo -e "${BLUE}[2/5] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! npm run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 通过${NC}"
echo ""

# Sidecar + Bridge + CLI 打包 —— 三件套统一通过 `npm run build:*`
# (`node scripts/esbuild-bundle.mjs <target>`)。Driver 内部 post-build：
# - cli: 复制 zhishi.cmd 到 resources/cli/
# - server: 校验产物不含硬编码 __dirname 路径
echo -e "${BLUE}[3/5] 打包 Sidecar / CLI ...${NC}"
npm run build:server
npm run build:cli

# 填充 tsx-runtime 资源（Plugin Bridge 通过绝对路径 --import 引用）。
# 用 npm 的 --os/--cpu 选择对应平台的 @esbuild/<triple>。
LINUX_TSX_CPU=$([[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]] && echo "arm64" || echo "x64")
echo -e "${BLUE}[3.1/5] 填充 tsx-runtime (linux-${LINUX_TSX_CPU})...${NC}"
npm run build:tsx-runtime -- linux "${LINUX_TSX_CPU}"
echo -e "${GREEN}✓ 打包完成${NC}"
echo ""

# M4c: Claude Agent SDK 已删除——不再创建 claude-agent-sdk 资源目录。

# 前端 GUI 已删除（无窗口后台宿主形态）——server/bridge/cli 三个 Node
# bundle 由 tauri build 的 beforeBuildCommand 构建，无需前端 dist。

# Tauri 构建
echo -e "${BLUE}[4/5] 构建 Tauri (AppImage + deb)...${NC}"
HOST_ARCH=$(uname -m)
if [[ "$HOST_ARCH" == "aarch64" || "$HOST_ARCH" == "arm64" ]]; then
    DEFAULT_TARGET="aarch64-unknown-linux-gnu"
    SDK_TRIPLE="linux-arm64"
    NODE_ARCH="arm64"
else
    DEFAULT_TARGET="x86_64-unknown-linux-gnu"
    SDK_TRIPLE="linux-x64"
    NODE_ARCH="x64"
fi
TARGET="${1:-$DEFAULT_TARGET}"

echo -e "  ${CYAN}目标: ${TARGET} (SDK: ${SDK_TRIPLE})${NC}"

# 确保 Node.js 匹配目标架构
"${PROJECT_DIR}/scripts/download_nodejs.sh"

# M4c: Claude Agent SDK 已删除——不再分发 claude native binary。

# 1.2.3：zhishi-updater（externalBin）本地 crate 随构建产出——缺它 tauri_build 失败
cargo build --release -p zhishi-updater --manifest-path "${PROJECT_DIR}/src-tauri/Cargo.toml" --target "$TARGET"
mkdir -p "${PROJECT_DIR}/src-tauri/binaries"
cp "${PROJECT_DIR}/src-tauri/target/${TARGET}/release/zhishi-updater" "${PROJECT_DIR}/src-tauri/binaries/zhishi-updater-${TARGET}"

npm run tauri:build -- --target "$TARGET" --bundles appimage,deb

echo ""
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/${TARGET}/release/bundle"

echo -e "${BLUE}[5/5] 输出产物${NC}"
APPIMAGE_PATH=$(find "${BUNDLE_DIR}/appimage" -name "*.AppImage" 2>/dev/null | head -1)
DEB_PATH=$(find "${BUNDLE_DIR}/deb" -name "*.deb" 2>/dev/null | head -1)

if [ -n "$APPIMAGE_PATH" ]; then
    APPIMAGE_SIZE=$(du -h "$APPIMAGE_PATH" | cut -f1)
    echo -e "  ${CYAN}AppImage:${NC} ${APPIMAGE_PATH} (${APPIMAGE_SIZE})"
fi
if [ -n "$DEB_PATH" ]; then
    DEB_SIZE=$(du -h "$DEB_PATH" | cut -f1)
    echo -e "  ${CYAN}deb:${NC} ${DEB_PATH} (${DEB_SIZE})"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Linux 构建完成!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
