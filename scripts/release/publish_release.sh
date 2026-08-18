#!/bin/bash
# ZhiShi 本地发布脚本
# 将构建产物上传到 Cloudflare R2，并生成更新清单
#
# 前置条件：
# 1. 已运行 ./scripts/build/build_macos.sh 完成构建
# 2. .env 中配置了 R2 凭证：
#    - R2_ACCESS_KEY_ID
#    - R2_SECRET_ACCESS_KEY
#    - R2_ACCOUNT_ID
# 3. .env 中配置了 Cloudflare 缓存清除凭证（可选但推荐）：
#    - CF_ZONE_ID        (Cloudflare Zone ID)
#    - CF_API_TOKEN      (需要 Zone.Cache Purge 权限)
# 4. 安装 rclone: brew install rclone

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target"
ENV_FILE="${PROJECT_DIR}/.env"

# 配置
R2_BUCKET="zhishi-releases"
DOWNLOAD_BASE_URL="https://download.zhishi.help"

# 架构名称辅助函数（避免重复计算逻辑）
get_arch_suffix() {
    local target="$1"
    if [ "$target" = "aarch64-apple-darwin" ]; then
        echo "aarch64"
    else
        echo "x86_64"
    fi
}

# 获取带架构后缀的 tar.gz 文件名
# 用法: get_tar_upload_name "ZhiShi.app.tar.gz" "aarch64-apple-darwin"
# 输出: ZhiShi_aarch64.app.tar.gz
get_tar_upload_name() {
    local base="$1"
    local target="$2"
    local suffix=$(get_arch_suffix "$target")
    echo "${base%.app.tar.gz}_${suffix}.app.tar.gz"
}

# 获取带架构后缀的 sig 文件名
get_sig_upload_name() {
    local base="$1"
    local target="$2"
    local suffix=$(get_arch_suffix "$target")
    echo "${base%.app.tar.gz.sig}_${suffix}.app.tar.gz.sig"
}

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🚀 ZhiShi 发布到 Cloudflare R2${NC}                     ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${BLUE}Version: ${VERSION}${NC}                                      ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# ========================================
# 加载环境变量
# ========================================
echo -e "${BLUE}[1/7] 加载配置...${NC}"
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
    echo -e "${GREEN}✓ 已加载 .env${NC}"
else
    echo -e "${RED}错误: .env 文件不存在!${NC}"
    exit 1
fi

# 验证 R2 配置
if [ -z "$R2_ACCESS_KEY_ID" ] || [ -z "$R2_SECRET_ACCESS_KEY" ] || [ -z "$R2_ACCOUNT_ID" ]; then
    echo -e "${RED}错误: R2 配置不完整!${NC}"
    echo "请在 .env 中配置:"
    echo "  R2_ACCESS_KEY_ID=xxx"
    echo "  R2_SECRET_ACCESS_KEY=xxx"
    echo "  R2_ACCOUNT_ID=xxx"
    exit 1
fi
echo -e "${GREEN}✓ R2 配置已验证${NC}"
echo ""

# ========================================
# 检查 rclone
# ========================================
echo -e "${BLUE}[2/7] 检查 rclone...${NC}"
if ! command -v rclone &> /dev/null; then
    echo -e "${YELLOW}rclone 未安装，正在安装...${NC}"
    brew install rclone
fi
echo -e "${GREEN}✓ rclone 已就绪${NC}"

# 配置 rclone（临时配置，限制权限防止凭证泄露）
RCLONE_CONFIG=$(mktemp)
chmod 600 "$RCLONE_CONFIG"
cat > "$RCLONE_CONFIG" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
EOF

# 清理函数（确保敏感临时文件被删除）
cleanup() {
    rm -f "$RCLONE_CONFIG" 2>/dev/null || true
    [ -n "$MANIFEST_DIR" ] && rm -rf "$MANIFEST_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo ""

# ========================================
# 物料完整性检查 (防呆机制)
# ========================================
echo -e "${BLUE}[3/7] 物料完整性检查...${NC}"
echo ""

# 收集所有物料信息
ARM_DMG=""
ARM_TAR=""
ARM_SIG=""
INTEL_DMG=""
INTEL_TAR=""
INTEL_SIG=""

# 检查 ARM 版本
ARM_DIR="${BUNDLE_DIR}/aarch64-apple-darwin/release/bundle"
if [ -d "$ARM_DIR" ]; then
    ARM_DMG=$(find "${ARM_DIR}/dmg" -name "*.dmg" 2>/dev/null | head -1)
    ARM_TAR=$(find "${ARM_DIR}/macos" -name "*.app.tar.gz" ! -name "*.sig" 2>/dev/null | head -1)
    ARM_SIG=$(find "${ARM_DIR}/macos" -name "*.app.tar.gz.sig" 2>/dev/null | head -1)
fi

# 检查 Intel 版本
INTEL_DIR="${BUNDLE_DIR}/x86_64-apple-darwin/release/bundle"
if [ -d "$INTEL_DIR" ]; then
    INTEL_DMG=$(find "${INTEL_DIR}/dmg" -name "*.dmg" 2>/dev/null | head -1)
    INTEL_TAR=$(find "${INTEL_DIR}/macos" -name "*.app.tar.gz" ! -name "*.sig" 2>/dev/null | head -1)
    INTEL_SIG=$(find "${INTEL_DIR}/macos" -name "*.app.tar.gz.sig" 2>/dev/null | head -1)
fi

# 显示物料清单
echo -e "  ${CYAN}┌─────────────────────────────────────────────────────────┐${NC}"
echo -e "  ${CYAN}│${NC}  ${BLUE}物料清单 - v${VERSION}${NC}                                      ${CYAN}│${NC}"
echo -e "  ${CYAN}├─────────────────────────────────────────────────────────┤${NC}"

# ARM 版本
echo -e "  ${CYAN}│${NC}  ${YELLOW}Apple Silicon (ARM64)${NC}                                  ${CYAN}│${NC}"
if [ -n "$ARM_DMG" ]; then
    echo -e "  ${CYAN}│${NC}    ${GREEN}✓${NC} DMG:    $(basename "$ARM_DMG")              ${CYAN}│${NC}"
else
    echo -e "  ${CYAN}│${NC}    ${RED}✗${NC} DMG:    缺失                                     ${CYAN}│${NC}"
fi
if [ -n "$ARM_TAR" ]; then
    echo -e "  ${CYAN}│${NC}    ${GREEN}✓${NC} tar.gz: $(basename "$ARM_TAR")      ${CYAN}│${NC}"
else
    echo -e "  ${CYAN}│${NC}    ${RED}✗${NC} tar.gz: 缺失                                     ${CYAN}│${NC}"
fi
if [ -n "$ARM_SIG" ]; then
    echo -e "  ${CYAN}│${NC}    ${GREEN}✓${NC} 签名:   $(basename "$ARM_SIG")  ${CYAN}│${NC}"
else
    echo -e "  ${CYAN}│${NC}    ${RED}✗${NC} 签名:   缺失                                     ${CYAN}│${NC}"
fi

echo -e "  ${CYAN}│${NC}                                                         ${CYAN}│${NC}"

# Intel 版本
echo -e "  ${CYAN}│${NC}  ${YELLOW}Intel (x86_64)${NC}                                         ${CYAN}│${NC}"
if [ -n "$INTEL_DMG" ]; then
    echo -e "  ${CYAN}│${NC}    ${GREEN}✓${NC} DMG:    $(basename "$INTEL_DMG")                 ${CYAN}│${NC}"
else
    echo -e "  ${CYAN}│${NC}    ${RED}✗${NC} DMG:    缺失                                     ${CYAN}│${NC}"
fi
if [ -n "$INTEL_TAR" ]; then
    echo -e "  ${CYAN}│${NC}    ${GREEN}✓${NC} tar.gz: $(basename "$INTEL_TAR")         ${CYAN}│${NC}"
else
    echo -e "  ${CYAN}│${NC}    ${RED}✗${NC} tar.gz: 缺失                                     ${CYAN}│${NC}"
fi
if [ -n "$INTEL_SIG" ]; then
    echo -e "  ${CYAN}│${NC}    ${GREEN}✓${NC} 签名:   $(basename "$INTEL_SIG")     ${CYAN}│${NC}"
else
    echo -e "  ${CYAN}│${NC}    ${RED}✗${NC} 签名:   缺失                                     ${CYAN}│${NC}"
fi

echo -e "  ${CYAN}└─────────────────────────────────────────────────────────┘${NC}"
echo ""

# 统计问题
CRITICAL_ERRORS=0
WARNINGS=0
ERROR_MESSAGES=""
WARNING_MESSAGES=""

# 检查官网下载渠道 (DMG)
if [ -z "$ARM_DMG" ] && [ -z "$INTEL_DMG" ]; then
    CRITICAL_ERRORS=$((CRITICAL_ERRORS + 1))
    ERROR_MESSAGES="${ERROR_MESSAGES}\n  • 没有任何 DMG 文件，官网下载将完全不可用"
elif [ -z "$ARM_DMG" ]; then
    WARNINGS=$((WARNINGS + 1))
    WARNING_MESSAGES="${WARNING_MESSAGES}\n  • 缺少 ARM DMG，Apple Silicon 用户无法从官网下载"
elif [ -z "$INTEL_DMG" ]; then
    WARNINGS=$((WARNINGS + 1))
    WARNING_MESSAGES="${WARNING_MESSAGES}\n  • 缺少 Intel DMG，Intel Mac 用户无法从官网下载"
fi

# 检查自动更新渠道 (tar.gz + sig)
if [ -z "$ARM_TAR" ] && [ -z "$INTEL_TAR" ]; then
    WARNINGS=$((WARNINGS + 1))
    WARNING_MESSAGES="${WARNING_MESSAGES}\n  • 没有任何 tar.gz 文件，自动更新将完全不可用"
else
    if [ -n "$ARM_TAR" ] && [ -z "$ARM_SIG" ]; then
        WARNINGS=$((WARNINGS + 1))
        WARNING_MESSAGES="${WARNING_MESSAGES}\n  • ARM 缺少签名文件，ARM 用户自动更新将失败"
    fi
    if [ -n "$INTEL_TAR" ] && [ -z "$INTEL_SIG" ]; then
        WARNINGS=$((WARNINGS + 1))
        WARNING_MESSAGES="${WARNING_MESSAGES}\n  • Intel 缺少签名文件，Intel 用户自动更新将失败"
    fi
fi

# 显示问题汇总
if [ $CRITICAL_ERRORS -gt 0 ]; then
    echo -e "${RED}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  ❌ 发现 ${CRITICAL_ERRORS} 个严重错误，无法继续发布                    ║${NC}"
    echo -e "${RED}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo -e "${RED}${ERROR_MESSAGES}${NC}"
    echo ""
    echo -e "请先运行 ${CYAN}./scripts/build/build_macos.sh${NC} 完成构建"
    exit 1
fi

if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║  ⚠️  发现 ${WARNINGS} 个警告                                        ║${NC}"
    echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo -e "${YELLOW}${WARNING_MESSAGES}${NC}"
    echo ""
    echo -e "${YELLOW}继续发布可能导致部分用户无法下载或更新!${NC}"
    echo ""
    read -p "确定要继续发布吗? (输入 'yes' 继续): " -r CONFIRM
    if [ "$CONFIRM" != "yes" ]; then
        echo -e "${RED}发布已取消${NC}"
        exit 1
    fi
    echo ""
else
    echo -e "${GREEN}✓ 物料检查通过，所有文件就绪${NC}"
fi

# 构建 FOUND_TARGETS 数组供后续使用
FOUND_TARGETS=()
[ -n "$ARM_DMG" ] || [ -n "$ARM_TAR" ] && FOUND_TARGETS+=("aarch64-apple-darwin")
[ -n "$INTEL_DMG" ] || [ -n "$INTEL_TAR" ] && FOUND_TARGETS+=("x86_64-apple-darwin")

echo ""

# ========================================
# 生成更新包和签名
# ========================================
echo -e "${BLUE}[4/7] 生成更新清单...${NC}"

# 临时目录存放 manifest
MANIFEST_DIR=$(mktemp -d)
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 用于 latest.json (避免使用 bash 4+ 的关联数组)
DMG_ARM64=""
DMG_X64=""

for TARGET in "${FOUND_TARGETS[@]}"; do
    TARGET_DIR="${BUNDLE_DIR}/${TARGET}/release/bundle"

    echo -e "  ${CYAN}处理 $TARGET...${NC}"

    # 查找文件
    DMG=$(find "${TARGET_DIR}/dmg" -name "*.dmg" 2>/dev/null | head -1)
    APP=$(find "${TARGET_DIR}/macos" -name "*.app" 2>/dev/null | head -1)
    TAR_GZ=$(find "${TARGET_DIR}/macos" -name "*.app.tar.gz" ! -name "*.sig" 2>/dev/null | head -1)
    SIG=$(find "${TARGET_DIR}/macos" -name "*.app.tar.gz.sig" 2>/dev/null | head -1)

    # 如果没有 tar.gz，从 .app 生成
    if [ -z "$TAR_GZ" ] && [ -n "$APP" ]; then
        APP_NAME=$(basename "$APP")
        TAR_GZ="${TARGET_DIR}/macos/${APP_NAME}.tar.gz"
        echo -e "    ${YELLOW}生成 tar.gz...${NC}"
        tar -czf "$TAR_GZ" -C "${TARGET_DIR}/macos" "$APP_NAME"
    fi

    # 如果没有签名文件，尝试生成
    if [ -z "$SIG" ] && [ -n "$TAR_GZ" ] && [ -n "$TAURI_SIGNING_PRIVATE_KEY" ]; then
        SIG="${TAR_GZ}.sig"
        echo -e "    ${YELLOW}生成签名...${NC}"

        # 写入临时密钥文件 (tauri signer 需要文件路径，限制权限)
        TEMP_KEY_FILE=$(mktemp)
        chmod 600 "$TEMP_KEY_FILE"
        echo "$TAURI_SIGNING_PRIVATE_KEY" > "$TEMP_KEY_FILE"

        if command -v tauri &> /dev/null; then
            if [ -n "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ]; then
                tauri signer sign -k "$TEMP_KEY_FILE" -p "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "$TAR_GZ"
            else
                tauri signer sign -k "$TEMP_KEY_FILE" "$TAR_GZ"
            fi

            if [ -f "$SIG" ]; then
                echo -e "    ${GREEN}✓${NC} 签名已生成"
            else
                echo -e "    ${RED}✗${NC} 签名生成失败"
                SIG=""
            fi
        else
            echo -e "    ${RED}✗${NC} tauri CLI 未安装，无法生成签名"
            SIG=""
        fi

        rm -f "$TEMP_KEY_FILE"
    fi

    # 记录 DMG 文件名
    if [ -n "$DMG" ]; then
        DMG_BASENAME=$(basename "$DMG")
        if [ "$TARGET" = "aarch64-apple-darwin" ]; then
            DMG_ARM64="$DMG_BASENAME"
        else
            DMG_X64="$DMG_BASENAME"
        fi
    fi

    # 生成 manifest (先生成，后面统一上传)
    if [ "$TARGET" = "aarch64-apple-darwin" ]; then
        MANIFEST_NAME="darwin-aarch64"
    else
        MANIFEST_NAME="darwin-x86_64"
    fi

    # 读取签名（如果存在）
    SIGNATURE=""
    if [ -n "$SIG" ] && [ -f "$SIG" ]; then
        SIGNATURE=$(cat "$SIG")
    fi

    TAR_FILENAME=$(basename "$TAR_GZ" 2>/dev/null || echo "")

    # 为 tar.gz 文件名添加架构标识，避免 ARM 和 Intel 互相覆盖
    # ZhiShi.app.tar.gz -> ZhiShi_aarch64.app.tar.gz 或 ZhiShi_x86_64.app.tar.gz
    if [ -n "$TAR_FILENAME" ]; then
        TAR_UPLOAD_NAME=$(get_tar_upload_name "$TAR_FILENAME" "$TARGET")
    fi

    if [ -n "$TAR_FILENAME" ]; then
        # Tauri Updater v2 动态服务器格式（适用于单平台 JSON 文件）
        # 参考: https://v2.tauri.app/plugin/updater/
        # 必需字段: version, url, signature
        # 可选字段: pub_date, notes
        # 注意: 不要添加额外字段如 "platform"，平台信息由 URL 路径 (darwin-aarch64.json) 区分
        cat > "${MANIFEST_DIR}/${MANIFEST_NAME}.json" << EOF
{
  "version": "${VERSION}",
  "notes": "ZhiShi v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "signature": "${SIGNATURE}",
  "url": "${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${TAR_UPLOAD_NAME}"
}
EOF
        echo -e "    ${GREEN}✓${NC} ${MANIFEST_NAME}.json 已生成"

        # 检查签名是否为空
        if [ -z "$SIGNATURE" ]; then
            echo -e "    ${YELLOW}⚠️  警告: 签名为空，自动更新将验证失败${NC}"
        fi
    fi
done

# 生成 latest.json（只包含存在的平台）
LATEST_JSON="{\n  \"version\": \"${VERSION}\",\n  \"pub_date\": \"${PUB_DATE}\",\n  \"release_notes\": \"ZhiShi v${VERSION}\",\n  \"downloads\": {"

DOWNLOADS_ADDED=0
if [ -n "$DMG_ARM64" ]; then
    LATEST_JSON="${LATEST_JSON}\n    \"mac_arm64\": {\n      \"name\": \"Apple Silicon\",\n      \"url\": \"${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${DMG_ARM64}\"\n    }"
    DOWNLOADS_ADDED=1
fi

if [ -n "$DMG_X64" ]; then
    if [ $DOWNLOADS_ADDED -eq 1 ]; then
        LATEST_JSON="${LATEST_JSON},"
    fi
    LATEST_JSON="${LATEST_JSON}\n    \"mac_intel\": {\n      \"name\": \"Intel Mac\",\n      \"url\": \"${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${DMG_X64}\"\n    }"
fi

LATEST_JSON="${LATEST_JSON}\n  }\n}"

echo -e "$LATEST_JSON" > "${MANIFEST_DIR}/latest.json"
echo -e "  ${GREEN}✓${NC} latest.json 已生成"

echo ""

# ========================================
# 上传构建产物
# ========================================
echo -e "${BLUE}[5/7] 上传前最终确认...${NC}"

# 统计将要上传的文件
UPLOAD_FILES=()

for TARGET in "${FOUND_TARGETS[@]}"; do
    if [ "$TARGET" = "aarch64-apple-darwin" ]; then
        [ -n "$ARM_DMG" ] && [ -f "$ARM_DMG" ] && UPLOAD_FILES+=("$ARM_DMG")
        [ -n "$ARM_TAR" ] && [ -f "$ARM_TAR" ] && UPLOAD_FILES+=("$ARM_TAR")
        [ -n "$ARM_SIG" ] && [ -f "$ARM_SIG" ] && UPLOAD_FILES+=("$ARM_SIG")
    else
        [ -n "$INTEL_DMG" ] && [ -f "$INTEL_DMG" ] && UPLOAD_FILES+=("$INTEL_DMG")
        [ -n "$INTEL_TAR" ] && [ -f "$INTEL_TAR" ] && UPLOAD_FILES+=("$INTEL_TAR")
        [ -n "$INTEL_SIG" ] && [ -f "$INTEL_SIG" ] && UPLOAD_FILES+=("$INTEL_SIG")
    fi
done

echo ""
echo -e "  ${CYAN}即将上传的文件:${NC}"
for f in "${UPLOAD_FILES[@]}"; do
    SIZE=$(du -h "$f" | cut -f1)
    echo -e "    • $(basename "$f") (${SIZE})"
done
echo ""
echo -e "  ${CYAN}即将上传的清单:${NC}"
echo -e "    • darwin-aarch64.json"
echo -e "    • darwin-x86_64.json"
echo -e "    • latest.json"
echo ""
echo -e "  ${CYAN}目标位置:${NC}"
echo -e "    • 文件: ${DOWNLOAD_BASE_URL}/releases/v${VERSION}/"
echo -e "    • 清单: ${DOWNLOAD_BASE_URL}/update/"
echo ""

read -p "确认上传? (Y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo -e "${RED}发布已取消${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}[6/7] 上传构建产物到 R2...${NC}"

UPLOAD_SUCCESS=0
UPLOAD_FAILED=0

for TARGET in "${FOUND_TARGETS[@]}"; do
    TARGET_DIR="${BUNDLE_DIR}/${TARGET}/release/bundle"

    if [ "$TARGET" = "aarch64-apple-darwin" ]; then
        ARCH_NAME="ARM"
    else
        ARCH_NAME="Intel"
    fi

    echo -e "  ${CYAN}上传 $ARCH_NAME 版本...${NC}"

    # 查找文件
    DMG=$(find "${TARGET_DIR}/dmg" -name "*.dmg" 2>/dev/null | head -1)
    TAR_GZ=$(find "${TARGET_DIR}/macos" -name "*.app.tar.gz" ! -name "*.sig" 2>/dev/null | head -1)
    SIG=$(find "${TARGET_DIR}/macos" -name "*.app.tar.gz.sig" 2>/dev/null | head -1)

    # 上传 DMG (官网下载用)
    if [ -n "$DMG" ] && [ -f "$DMG" ]; then
        if rclone --config="$RCLONE_CONFIG" copy "$DMG" "r2:${R2_BUCKET}/releases/v${VERSION}/" --s3-no-check-bucket --progress; then
            echo -e "    ${GREEN}✓${NC} DMG: $(basename "$DMG")"
            ((UPLOAD_SUCCESS++))
        else
            echo -e "    ${RED}✗${NC} DMG 上传失败"
            ((UPLOAD_FAILED++))
        fi
    fi

    # 上传 tar.gz (自动更新用) - 使用带架构的文件名避免覆盖
    if [ -n "$TAR_GZ" ] && [ -f "$TAR_GZ" ]; then
        TAR_BASE=$(basename "$TAR_GZ")
        TAR_DEST_NAME=$(get_tar_upload_name "$TAR_BASE" "$TARGET")
        # 使用 copyto 指定目标文件名
        if rclone --config="$RCLONE_CONFIG" copyto "$TAR_GZ" "r2:${R2_BUCKET}/releases/v${VERSION}/${TAR_DEST_NAME}" --s3-no-check-bucket --progress; then
            echo -e "    ${GREEN}✓${NC} tar.gz: ${TAR_DEST_NAME}"
            ((UPLOAD_SUCCESS++))
        else
            echo -e "    ${RED}✗${NC} tar.gz 上传失败"
            ((UPLOAD_FAILED++))
        fi
    fi

    # 上传签名文件 (自动更新验证用) - 使用带架构的文件名
    if [ -n "$SIG" ] && [ -f "$SIG" ]; then
        SIG_BASE=$(basename "$SIG")
        SIG_DEST_NAME=$(get_sig_upload_name "$SIG_BASE" "$TARGET")
        if rclone --config="$RCLONE_CONFIG" copyto "$SIG" "r2:${R2_BUCKET}/releases/v${VERSION}/${SIG_DEST_NAME}" --s3-no-check-bucket --progress; then
            echo -e "    ${GREEN}✓${NC} 签名: ${SIG_DEST_NAME}"
            ((UPLOAD_SUCCESS++))
        else
            echo -e "    ${RED}✗${NC} 签名上传失败"
            ((UPLOAD_FAILED++))
        fi
    else
        echo -e "    ${YELLOW}⚠️${NC} 无签名文件"
    fi
done

echo ""
echo -e "  上传统计: ${GREEN}成功 ${UPLOAD_SUCCESS}${NC} / ${RED}失败 ${UPLOAD_FAILED}${NC}"

if [ $UPLOAD_FAILED -gt 0 ]; then
    echo -e "${RED}警告: 部分文件上传失败!${NC}"
fi

echo ""

# ========================================
# 上传 manifest
# ========================================
echo -e "${BLUE}[7/7] 上传更新清单...${NC}"

rclone --config="$RCLONE_CONFIG" copy "${MANIFEST_DIR}/" "r2:${R2_BUCKET}/update/" --s3-no-check-bucket --progress

echo -e "${GREEN}✓ 所有清单已上传${NC}"
echo ""

# ========================================
# 完成
# ========================================
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 发布完成!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}版本:${NC} v${VERSION}"
echo ""

# 官网下载渠道
echo -e "  ${CYAN}📥 官网下载 (DMG):${NC}"
if [ -n "$DMG_ARM64" ]; then
    echo -e "    Apple Silicon: ${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${DMG_ARM64}"
fi
if [ -n "$DMG_X64" ]; then
    echo -e "    Intel Mac:     ${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${DMG_X64}"
fi
echo ""

# 自动更新渠道
echo -e "  ${CYAN}🔄 自动更新 (Tauri Updater):${NC}"
echo -e "    ARM64 清单:  ${DOWNLOAD_BASE_URL}/update/darwin-aarch64.json"
echo -e "    x86_64 清单: ${DOWNLOAD_BASE_URL}/update/darwin-x86_64.json"
echo ""

# 官网 API
echo -e "  ${CYAN}🌐 官网 API:${NC}"
echo -e "    Latest:      ${DOWNLOAD_BASE_URL}/update/latest.json"
echo ""

# ========================================
# 清除 Cloudflare CDN 缓存
# ========================================
if [ -n "$CF_ZONE_ID" ] && [ -n "$CF_API_TOKEN" ]; then
    echo -e "  ${CYAN}🔄 清除 Cloudflare CDN 缓存...${NC}"

    # 构建需要清除缓存的 URL 列表
    PURGE_URLS=()
    PURGE_URLS+=("${DOWNLOAD_BASE_URL}/update/latest.json")
    PURGE_URLS+=("${DOWNLOAD_BASE_URL}/update/darwin-aarch64.json")
    PURGE_URLS+=("${DOWNLOAD_BASE_URL}/update/darwin-x86_64.json")

    # 添加构建产物 URL（注意：tar.gz 和 sig 使用带架构后缀的文件名）
    if [ -n "$ARM_TAR" ]; then
        ARM_TAR_BASE=$(basename "$ARM_TAR")
        ARM_TAR_PURGE=$(get_tar_upload_name "$ARM_TAR_BASE" "aarch64-apple-darwin")
        ARM_SIG_PURGE=$(get_sig_upload_name "${ARM_TAR_BASE}.sig" "aarch64-apple-darwin")
        PURGE_URLS+=("${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${ARM_TAR_PURGE}")
        [ -n "$ARM_SIG" ] && PURGE_URLS+=("${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${ARM_SIG_PURGE}")
        [ -n "$ARM_DMG" ] && PURGE_URLS+=("${DOWNLOAD_BASE_URL}/releases/v${VERSION}/$(basename "$ARM_DMG")")
    fi
    if [ -n "$INTEL_TAR" ]; then
        INTEL_TAR_BASE=$(basename "$INTEL_TAR")
        INTEL_TAR_PURGE=$(get_tar_upload_name "$INTEL_TAR_BASE" "x86_64-apple-darwin")
        INTEL_SIG_PURGE=$(get_sig_upload_name "${INTEL_TAR_BASE}.sig" "x86_64-apple-darwin")
        PURGE_URLS+=("${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${INTEL_TAR_PURGE}")
        [ -n "$INTEL_SIG" ] && PURGE_URLS+=("${DOWNLOAD_BASE_URL}/releases/v${VERSION}/${INTEL_SIG_PURGE}")
        [ -n "$INTEL_DMG" ] && PURGE_URLS+=("${DOWNLOAD_BASE_URL}/releases/v${VERSION}/$(basename "$INTEL_DMG")")
    fi

    # 构建 JSON 数组
    PURGE_JSON='{"files":['
    FIRST=1
    for url in "${PURGE_URLS[@]}"; do
        if [ $FIRST -eq 1 ]; then
            FIRST=0
        else
            PURGE_JSON+=','
        fi
        PURGE_JSON+="\"$url\""
    done
    PURGE_JSON+=']}'

    # 调用 Cloudflare API 清除缓存
    # API 文档: https://developers.cloudflare.com/api/resources/cache/methods/purge/
    PURGE_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$PURGE_JSON")

    if echo "$PURGE_RESPONSE" | grep -q '"success":true'; then
        echo -e "    ${GREEN}✓${NC} CDN 缓存已清除 (${#PURGE_URLS[@]} 个文件)"
    else
        echo -e "    ${YELLOW}⚠️${NC} CDN 缓存清除可能失败"
        echo -e "    ${YELLOW}响应: $(echo "$PURGE_RESPONSE" | head -c 200)${NC}"
    fi
    echo ""
else
    echo -e "  ${YELLOW}⚠️  未配置 CF_ZONE_ID 或 CF_API_TOKEN，跳过 CDN 缓存清除${NC}"
    echo -e "  ${YELLOW}   建议在 .env 中配置以确保更新立即生效${NC}"
    echo ""
fi

# ========================================
# 上传后验证
# ========================================
echo -e "  ${CYAN}📋 验证上传结果...${NC}"
echo ""

VERIFY_FAILED=0

# 验证 latest.json
echo -n "    检查 latest.json... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${DOWNLOAD_BASE_URL}/update/latest.json" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ (HTTP $HTTP_CODE)${NC}"
    VERIFY_FAILED=1
fi

# 验证 darwin-aarch64.json
if [ -n "$ARM_TAR" ]; then
    echo -n "    检查 darwin-aarch64.json... "
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${DOWNLOAD_BASE_URL}/update/darwin-aarch64.json" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗ (HTTP $HTTP_CODE)${NC}"
        VERIFY_FAILED=1
    fi
fi

# 验证 darwin-x86_64.json
if [ -n "$INTEL_TAR" ]; then
    echo -n "    检查 darwin-x86_64.json... "
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${DOWNLOAD_BASE_URL}/update/darwin-x86_64.json" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗ (HTTP $HTTP_CODE)${NC}"
        VERIFY_FAILED=1
    fi
fi

# 验证 DMG 文件
if [ -n "$ARM_DMG" ]; then
    echo -n "    检查 ARM DMG... "
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -I "${DOWNLOAD_BASE_URL}/releases/v${VERSION}/$(basename "$ARM_DMG")" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗ (HTTP $HTTP_CODE)${NC}"
        VERIFY_FAILED=1
    fi
fi

if [ -n "$INTEL_DMG" ]; then
    echo -n "    检查 Intel DMG... "
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -I "${DOWNLOAD_BASE_URL}/releases/v${VERSION}/$(basename "$INTEL_DMG")" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗ (HTTP $HTTP_CODE)${NC}"
        VERIFY_FAILED=1
    fi
fi

echo ""

if [ $VERIFY_FAILED -eq 1 ]; then
    echo -e "${YELLOW}⚠️  部分文件验证失败，可能是 CDN 缓存延迟，请稍后手动验证${NC}"
else
    echo -e "${GREEN}✓ 所有文件验证通过${NC}"
fi

# ========================================
# 上传到 GitHub Release (调用独立脚本)
# ========================================
echo -e "  ${CYAN}📦 上传到 GitHub Release...${NC}"

if "${PROJECT_DIR}/scripts/release/upload_github_release_mac.sh"; then
    echo -e "    ${GREEN}✓${NC} GitHub Release 上传完成"
else
    echo -e "    ${YELLOW}⚠️${NC} GitHub Release 上传失败，可稍后运行 ./scripts/release/upload_github_release_mac.sh 重试"
fi

# ========================================
# 通知工单服务有新版本发布
# ========================================
echo -e "  ${CYAN}🔔 通知工单服务版本发布...${NC}"

if [ -z "${API_KEY:-}" ]; then
    echo -e "  ${YELLOW}⚠️  未设置 API_KEY 环境变量，跳过${NC}"
else
    # 便携版 ZIP — macOS 没有便携版，用 tar.gz 代替
    # 如果后续 macOS 有便携版，调整此 URL
    NOTIFY_URL="${DOWNLOAD_BASE_URL}/releases/v${VERSION}/$(echo "$FOUND_TARGETS" | head -1 | xargs -I{} basename $(ls -1t ${BUNDLE_DIR}/{}/release/bundle/**/*.tar.gz 2>/dev/null | head -1) 2>/dev/null || echo 'unknown')"

    NOTIFY_PAYLOAD=$(cat <<JSON
{
  "version": "${VERSION}",
  "minimum_version": "0.2.30",
  "force_update_below": "0.2.28",
  "release_date": "$(date +%Y-%m-%d)",
  "release_notes": "ZhiShi v${VERSION}",
  "download_url": "${DOWNLOAD_BASE_URL}/releases/v${VERSION}/$(echo "$NOTIFY_URL" | xargs basename)"
}
JSON
)
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "https://ticket.zhishi.help/api/v1/client-version/admin" \
        -H "X-API-Key: ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$NOTIFY_PAYLOAD" 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" = "201" ]; then
        echo -e "    ${GREEN}✓${NC} 工单服务已更新 (v${VERSION})"
    else
        echo -e "    ${YELLOW}⚠️  工单服务通知失败 (HTTP $HTTP_CODE)${NC}"
    fi
fi

echo ""
echo -e "  ${CYAN}手动验证命令:${NC}"
echo -e "    curl -s ${DOWNLOAD_BASE_URL}/update/latest.json | jq ."
echo -e "    curl -s ${DOWNLOAD_BASE_URL}/update/darwin-aarch64.json | jq ."
echo ""

# 注：临时目录由 trap cleanup 自动清理
