#!/bin/bash
# ZhiShi 版本回滚脚本
# 从 R2 上已有的旧版本数据重建更新清单，实现版本回滚
#
# 原理：R2 上 releases/v{VERSION}/ 目录保留了所有历史版本的完整产物
# 回滚 = 用旧版本的数据重建 update/*.json 清单并上传覆盖当前版本
#
# 默认回滚全部 5 个清单（macOS + Windows），也可选择仅回滚单平台
# Windows 上请运行 ./scripts/release/rollback_release.ps1（功能完全相同，PowerShell 版本）
#
# 前置条件：
# 1. .env 中配置了 R2 凭证 (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID)
# 2. .env 中配置了 Cloudflare 缓存清除凭证（可选但强烈推荐）
# 3. 安装 rclone: brew install rclone

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"

# 配置
R2_BUCKET="zhishi-releases"
DOWNLOAD_BASE_URL="https://download.zhishi.help"

# 人类可读文件大小（兼容 macOS，无需 numfmt）
human_size() {
    local bytes=$1
    if [ "$bytes" -ge 1073741824 ]; then
        awk "BEGIN {printf \"%.2f GiB\", $bytes/1073741824}"
    elif [ "$bytes" -ge 1048576 ]; then
        awk "BEGIN {printf \"%.1f MiB\", $bytes/1048576}"
    elif [ "$bytes" -ge 1024 ]; then
        awk "BEGIN {printf \"%.1f KiB\", $bytes/1024}"
    else
        echo "${bytes} B"
    fi
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
echo -e "${CYAN}║${NC}  ${YELLOW}⏪ ZhiShi 版本回滚${NC}                                  ${CYAN}║${NC}"
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
    echo "请在 .env 中配置: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID"
    exit 1
fi
echo -e "${GREEN}✓ R2 配置已验证${NC}"
echo ""

# ========================================
# 检查 rclone
# ========================================
echo -e "${BLUE}[2/7] 检查 rclone...${NC}"
if ! command -v rclone &> /dev/null; then
    echo -e "${RED}错误: rclone 未安装${NC}"
    echo "请运行: brew install rclone"
    exit 1
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

# 临时目录
WORK_DIR=$(mktemp -d)

cleanup() {
    rm -f "$RCLONE_CONFIG" 2>/dev/null || true
    rm -rf "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo ""

# ========================================
# 查询当前线上版本
# ========================================
echo -e "${BLUE}[3/7] 查询版本信息...${NC}"

CURRENT_MAC_VERSION="(未知)"
CURRENT_WIN_VERSION="(未知)"

echo -e "  ${CYAN}获取当前线上版本...${NC}"

# 下载当前清单
rclone --config="$RCLONE_CONFIG" copy "r2:${R2_BUCKET}/update/" "${WORK_DIR}/current_update/" --s3-no-check-bucket 2>/dev/null || true

if [ -f "${WORK_DIR}/current_update/darwin-aarch64.json" ]; then
    CURRENT_MAC_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${WORK_DIR}/current_update/darwin-aarch64.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi
if [ -f "${WORK_DIR}/current_update/windows-x86_64.json" ]; then
    CURRENT_WIN_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${WORK_DIR}/current_update/windows-x86_64.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi

echo -e "  ${GREEN}✓${NC} 当前线上: macOS ${CYAN}v${CURRENT_MAC_VERSION}${NC} / Windows ${CYAN}v${CURRENT_WIN_VERSION}${NC}"
echo ""

# 列出 R2 上所有版本
echo -e "  ${CYAN}扫描 R2 上的历史版本...${NC}"

VERSIONS=()
while IFS= read -r line; do
    dir_name=$(echo "$line" | awk '{print $NF}')
    if [[ "$dir_name" == v* ]]; then
        ver="${dir_name#v}"
        VERSIONS+=("$ver")
    fi
done < <(rclone --config="$RCLONE_CONFIG" lsd "r2:${R2_BUCKET}/releases/" --s3-no-check-bucket 2>/dev/null)

if [ ${#VERSIONS[@]} -eq 0 ]; then
    echo -e "${RED}错误: R2 上没有找到任何版本${NC}"
    exit 1
fi

# 按版本号排序（降序）
IFS=$'\n' VERSIONS=($(printf '%s\n' "${VERSIONS[@]}" | sort -t. -k1,1nr -k2,2nr -k3,3nr)); unset IFS

echo ""
echo -e "  ${CYAN}┌─────────────────────────────────────────────────┐${NC}"
echo -e "  ${CYAN}│${NC}  ${BLUE}可用版本${NC}                                        ${CYAN}│${NC}"
echo -e "  ${CYAN}├─────────────────────────────────────────────────┤${NC}"

for i in "${!VERSIONS[@]}"; do
    ver="${VERSIONS[$i]}"
    MARKERS=""
    [ "$ver" = "$CURRENT_MAC_VERSION" ] && MARKERS="${MARKERS} mac"
    [ "$ver" = "$CURRENT_WIN_VERSION" ] && MARKERS="${MARKERS} win"
    if [ -n "$MARKERS" ]; then
        echo -e "  ${CYAN}│${NC}  [$(printf '%2d' $((i+1)))] v${ver}  ${YELLOW}← 当前线上(${MARKERS# })${NC}"
    else
        echo -e "  ${CYAN}│${NC}  [$(printf '%2d' $((i+1)))] v${ver}"
    fi
done

echo -e "  ${CYAN}└─────────────────────────────────────────────────┘${NC}"
echo ""

# 用户选择版本
read -p "输入要回滚到的版本号 (如 0.1.48) 或序号: " -r TARGET_INPUT

# 判断输入是序号还是版本号
if [[ "$TARGET_INPUT" =~ ^[0-9]+$ ]] && [ "$TARGET_INPUT" -ge 1 ] && [ "$TARGET_INPUT" -le ${#VERSIONS[@]} ]; then
    TARGET_VERSION="${VERSIONS[$((TARGET_INPUT-1))]}"
else
    TARGET_VERSION="${TARGET_INPUT#v}"
fi

# 验证版本存在
VERSION_FOUND=0
for ver in "${VERSIONS[@]}"; do
    if [ "$ver" = "$TARGET_VERSION" ]; then
        VERSION_FOUND=1
        break
    fi
done

if [ $VERSION_FOUND -eq 0 ]; then
    echo -e "${RED}错误: 版本 v${TARGET_VERSION} 不存在于 R2${NC}"
    exit 1
fi

echo ""
echo -e "  ${GREEN}✓${NC} 目标版本: ${CYAN}v${TARGET_VERSION}${NC}"
echo ""

# ========================================
# 选择回滚范围
# ========================================
echo -e "${BLUE}[4/7] 选择回滚范围...${NC}"
echo ""
echo -e "  [1] 全部回滚 (macOS + Windows)  ${YELLOW}← 默认${NC}"
echo -e "  [2] 仅 macOS  (darwin-aarch64.json + darwin-x86_64.json + latest.json)"
echo -e "  [3] 仅 Windows (windows-x86_64.json + latest_win.json)"
echo ""
read -p "选择 (1/2/3, 回车默认全部): " -r SCOPE_INPUT

ROLLBACK_MAC=0
ROLLBACK_WIN=0

case "${SCOPE_INPUT:-1}" in
    1|"") ROLLBACK_MAC=1; ROLLBACK_WIN=1 ;;
    2) ROLLBACK_MAC=1 ;;
    3) ROLLBACK_WIN=1 ;;
    *)
        echo -e "${RED}无效选择${NC}"
        exit 1
        ;;
esac

# 防止回滚到当前版本（按选定范围检查）
ALREADY_CURRENT=""
if [ $ROLLBACK_MAC -eq 1 ] && [ "$TARGET_VERSION" = "$CURRENT_MAC_VERSION" ]; then
    ALREADY_CURRENT="${ALREADY_CURRENT} macOS"
fi
if [ $ROLLBACK_WIN -eq 1 ] && [ "$TARGET_VERSION" = "$CURRENT_WIN_VERSION" ]; then
    ALREADY_CURRENT="${ALREADY_CURRENT} Windows"
fi

# 如果全部选定平台都已经是目标版本，则无需回滚
ALL_CURRENT=1
if [ $ROLLBACK_MAC -eq 1 ] && [ "$TARGET_VERSION" != "$CURRENT_MAC_VERSION" ]; then
    ALL_CURRENT=0
fi
if [ $ROLLBACK_WIN -eq 1 ] && [ "$TARGET_VERSION" != "$CURRENT_WIN_VERSION" ]; then
    ALL_CURRENT=0
fi

if [ $ALL_CURRENT -eq 1 ]; then
    echo -e "${YELLOW}⚠️  选定平台已经全部是 v${TARGET_VERSION}，无需回滚${NC}"
    exit 0
fi

if [ -n "$ALREADY_CURRENT" ]; then
    echo -e "  ${YELLOW}提示:${ALREADY_CURRENT} 已经是 v${TARGET_VERSION}，将跳过${NC}"
fi

echo ""

# ========================================
# 从 R2 获取旧版本数据并重建清单
# ========================================
echo -e "${BLUE}[5/7] 从 R2 获取旧版本数据并重建清单...${NC}"

# 列出目标版本的所有文件
R2_FILES=$(rclone --config="$RCLONE_CONFIG" ls "r2:${R2_BUCKET}/releases/v${TARGET_VERSION}/" --s3-no-check-bucket 2>/dev/null || echo "")

if [ -z "$R2_FILES" ]; then
    echo -e "${RED}错误: R2 上 releases/v${TARGET_VERSION}/ 目录为空或不存在${NC}"
    exit 1
fi

echo -e "  ${CYAN}R2 上 v${TARGET_VERSION} 的文件:${NC}"
echo "$R2_FILES" | while read -r size name; do
    if [ -n "$name" ]; then
        printf "    • %-50s %s\n" "$name" "$(human_size "$size")"
    fi
done
echo ""

# 创建清单输出目录
MANIFEST_DIR="${WORK_DIR}/manifests"
mkdir -p "$MANIFEST_DIR"

PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 下载 sig 文件
SIG_DIR="${WORK_DIR}/sigs"
mkdir -p "$SIG_DIR"

echo -e "  ${CYAN}下载签名文件...${NC}"
rclone --config="$RCLONE_CONFIG" copy "r2:${R2_BUCKET}/releases/v${TARGET_VERSION}/" "$SIG_DIR" \
    --include="*.sig" --s3-no-check-bucket 2>/dev/null || true

# --- macOS 清单 ---
if [ $ROLLBACK_MAC -eq 1 ] && [ "$TARGET_VERSION" != "$CURRENT_MAC_VERSION" ]; then
    echo ""
    echo -e "  ${CYAN}重建 macOS 清单...${NC}"

    # darwin-aarch64.json
    ARM_SIG_FILE=""
    ARM_TAR_NAME=""
    if [ -f "${SIG_DIR}/ZhiShi_${TARGET_VERSION}_aarch64.app.tar.gz.sig" ]; then
        ARM_SIG_FILE="${SIG_DIR}/ZhiShi_${TARGET_VERSION}_aarch64.app.tar.gz.sig"
        ARM_TAR_NAME="ZhiShi_${TARGET_VERSION}_aarch64.app.tar.gz"
    elif [ -f "${SIG_DIR}/ZhiShi_aarch64.app.tar.gz.sig" ]; then
        ARM_SIG_FILE="${SIG_DIR}/ZhiShi_aarch64.app.tar.gz.sig"
        ARM_TAR_NAME="ZhiShi_aarch64.app.tar.gz"
    fi

    if [ -n "$ARM_SIG_FILE" ]; then
        ARM_SIGNATURE=$(cat "$ARM_SIG_FILE")
        cat > "${MANIFEST_DIR}/darwin-aarch64.json" << EOFMANIFEST
{
  "version": "${TARGET_VERSION}",
  "notes": "ZhiShi v${TARGET_VERSION}",
  "pub_date": "${PUB_DATE}",
  "signature": "${ARM_SIGNATURE}",
  "url": "${DOWNLOAD_BASE_URL}/releases/v${TARGET_VERSION}/${ARM_TAR_NAME}"
}
EOFMANIFEST
        echo -e "    ${GREEN}✓${NC} darwin-aarch64.json"
    else
        echo -e "    ${YELLOW}⚠️${NC} 未找到 ARM 签名文件，跳过 darwin-aarch64.json"
    fi

    # darwin-x86_64.json
    INTEL_SIG_FILE=""
    INTEL_TAR_NAME=""
    if [ -f "${SIG_DIR}/ZhiShi_${TARGET_VERSION}_x86_64.app.tar.gz.sig" ]; then
        INTEL_SIG_FILE="${SIG_DIR}/ZhiShi_${TARGET_VERSION}_x86_64.app.tar.gz.sig"
        INTEL_TAR_NAME="ZhiShi_${TARGET_VERSION}_x86_64.app.tar.gz"
    elif [ -f "${SIG_DIR}/ZhiShi_x86_64.app.tar.gz.sig" ]; then
        INTEL_SIG_FILE="${SIG_DIR}/ZhiShi_x86_64.app.tar.gz.sig"
        INTEL_TAR_NAME="ZhiShi_x86_64.app.tar.gz"
    elif [ -f "${SIG_DIR}/ZhiShi_${TARGET_VERSION}_x64.app.tar.gz.sig" ]; then
        INTEL_SIG_FILE="${SIG_DIR}/ZhiShi_${TARGET_VERSION}_x64.app.tar.gz.sig"
        INTEL_TAR_NAME="ZhiShi_${TARGET_VERSION}_x64.app.tar.gz"
    fi

    if [ -n "$INTEL_SIG_FILE" ]; then
        INTEL_SIGNATURE=$(cat "$INTEL_SIG_FILE")
        cat > "${MANIFEST_DIR}/darwin-x86_64.json" << EOFMANIFEST
{
  "version": "${TARGET_VERSION}",
  "notes": "ZhiShi v${TARGET_VERSION}",
  "pub_date": "${PUB_DATE}",
  "signature": "${INTEL_SIGNATURE}",
  "url": "${DOWNLOAD_BASE_URL}/releases/v${TARGET_VERSION}/${INTEL_TAR_NAME}"
}
EOFMANIFEST
        echo -e "    ${GREEN}✓${NC} darwin-x86_64.json"
    else
        echo -e "    ${YELLOW}⚠️${NC} 未找到 Intel 签名文件，跳过 darwin-x86_64.json"
    fi

    # latest.json
    ARM_DMG_NAME=$(echo "$R2_FILES" | awk '{print $NF}' | grep -i "aarch64.*\.dmg$" | head -1 || echo "")
    INTEL_DMG_NAME=$(echo "$R2_FILES" | awk '{print $NF}' | grep -i "x64.*\.dmg$" | head -1 || echo "")

    if [ -n "$ARM_DMG_NAME" ] || [ -n "$INTEL_DMG_NAME" ]; then
        LATEST_JSON="{\n  \"version\": \"${TARGET_VERSION}\",\n  \"pub_date\": \"${PUB_DATE}\",\n  \"release_notes\": \"ZhiShi v${TARGET_VERSION}\",\n  \"downloads\": {"

        DOWNLOADS_ADDED=0
        if [ -n "$ARM_DMG_NAME" ]; then
            LATEST_JSON="${LATEST_JSON}\n    \"mac_arm64\": {\n      \"name\": \"Apple Silicon\",\n      \"url\": \"${DOWNLOAD_BASE_URL}/releases/v${TARGET_VERSION}/${ARM_DMG_NAME}\"\n    }"
            DOWNLOADS_ADDED=1
        fi
        if [ -n "$INTEL_DMG_NAME" ]; then
            if [ $DOWNLOADS_ADDED -eq 1 ]; then
                LATEST_JSON="${LATEST_JSON},"
            fi
            LATEST_JSON="${LATEST_JSON}\n    \"mac_intel\": {\n      \"name\": \"Intel Mac\",\n      \"url\": \"${DOWNLOAD_BASE_URL}/releases/v${TARGET_VERSION}/${INTEL_DMG_NAME}\"\n    }"
        fi
        LATEST_JSON="${LATEST_JSON}\n  }\n}"

        echo -e "$LATEST_JSON" > "${MANIFEST_DIR}/latest.json"
        echo -e "    ${GREEN}✓${NC} latest.json (ARM: ${ARM_DMG_NAME:-无}, Intel: ${INTEL_DMG_NAME:-无})"
    else
        echo -e "    ${YELLOW}⚠️${NC} 未找到 DMG 文件，跳过 latest.json"
    fi
fi

# --- Windows 清单 ---
if [ $ROLLBACK_WIN -eq 1 ] && [ "$TARGET_VERSION" != "$CURRENT_WIN_VERSION" ]; then
    echo ""
    echo -e "  ${CYAN}重建 Windows 清单...${NC}"

    # windows-x86_64.json
    WIN_SIG_FILE=""
    WIN_ZIP_NAME=""
    if [ -f "${SIG_DIR}/ZhiShi_${TARGET_VERSION}_x86_64.nsis.zip.sig" ]; then
        WIN_SIG_FILE="${SIG_DIR}/ZhiShi_${TARGET_VERSION}_x86_64.nsis.zip.sig"
        WIN_ZIP_NAME="ZhiShi_${TARGET_VERSION}_x86_64.nsis.zip"
    else
        # fallback: 查找任意 nsis.zip.sig
        WIN_SIG_FILE=$(find "$SIG_DIR" -name "*.nsis.zip.sig" 2>/dev/null | head -1)
        if [ -n "$WIN_SIG_FILE" ]; then
            WIN_ZIP_NAME=$(basename "$WIN_SIG_FILE" .sig)
        fi
    fi

    if [ -n "$WIN_SIG_FILE" ] && [ -f "$WIN_SIG_FILE" ]; then
        WIN_SIGNATURE=$(cat "$WIN_SIG_FILE")
        cat > "${MANIFEST_DIR}/windows-x86_64.json" << EOFMANIFEST
{
  "version": "${TARGET_VERSION}",
  "notes": "ZhiShi v${TARGET_VERSION}",
  "pub_date": "${PUB_DATE}",
  "signature": "${WIN_SIGNATURE}",
  "url": "${DOWNLOAD_BASE_URL}/releases/v${TARGET_VERSION}/${WIN_ZIP_NAME}"
}
EOFMANIFEST
        echo -e "    ${GREEN}✓${NC} windows-x86_64.json"
    else
        echo -e "    ${YELLOW}⚠️${NC} 未找到 Windows 签名文件，跳过 windows-x86_64.json"
    fi

    # latest_win.json
    WIN_EXE_NAME=$(echo "$R2_FILES" | awk '{print $NF}' | grep -i "setup\.exe$" | head -1 || echo "")

    if [ -n "$WIN_EXE_NAME" ]; then
        cat > "${MANIFEST_DIR}/latest_win.json" << EOFMANIFEST
{
  "version": "${TARGET_VERSION}",
  "pub_date": "${PUB_DATE}",
  "release_notes": "ZhiShi v${TARGET_VERSION}",
  "downloads": {
    "win_x64": {
      "name": "Windows x64",
      "url": "${DOWNLOAD_BASE_URL}/releases/v${TARGET_VERSION}/${WIN_EXE_NAME}"
    }
  }
}
EOFMANIFEST
        echo -e "    ${GREEN}✓${NC} latest_win.json (${WIN_EXE_NAME})"
    else
        echo -e "    ${YELLOW}⚠️${NC} 未找到 setup.exe，跳过 latest_win.json"
    fi
fi

# 检查是否有清单生成
MANIFEST_COUNT=$(find "$MANIFEST_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
if [ "$MANIFEST_COUNT" -eq 0 ]; then
    echo ""
    echo -e "${RED}错误: 没有成功生成任何清单文件，无法回滚${NC}"
    exit 1
fi

echo ""

# ========================================
# 确认回滚
# ========================================
echo -e "${BLUE}[6/7] 确认回滚...${NC}"
echo ""
echo -e "  ${CYAN}即将上传的清单:${NC}"
for f in "${MANIFEST_DIR}"/*.json; do
    [ -f "$f" ] || continue
    echo -e "    • $(basename "$f")"
done
echo ""
echo -e "  ${CYAN}回滚方向:${NC}"
if [ $ROLLBACK_MAC -eq 1 ] && [ "$TARGET_VERSION" != "$CURRENT_MAC_VERSION" ]; then
    echo -e "    macOS:   ${YELLOW}v${CURRENT_MAC_VERSION}${NC} → ${GREEN}v${TARGET_VERSION}${NC}"
fi
if [ $ROLLBACK_WIN -eq 1 ] && [ "$TARGET_VERSION" != "$CURRENT_WIN_VERSION" ]; then
    echo -e "    Windows: ${YELLOW}v${CURRENT_WIN_VERSION}${NC} → ${GREEN}v${TARGET_VERSION}${NC}"
fi

echo ""
echo -e "${RED}⚠️  此操作将覆盖线上更新清单，所有用户将看到回滚后的版本!${NC}"
read -p "确认回滚? (输入 'rollback' 继续): " -r CONFIRM
if [ "$CONFIRM" != "rollback" ]; then
    echo -e "${RED}回滚已取消${NC}"
    exit 1
fi

echo ""

# ========================================
# 上传清单到 R2
# ========================================
echo -e "${BLUE}[7/7] 上传回滚清单到 R2...${NC}"

rclone --config="$RCLONE_CONFIG" copy "${MANIFEST_DIR}/" "r2:${R2_BUCKET}/update/" --s3-no-check-bucket --progress

echo -e "${GREEN}✓ 清单已上传${NC}"
echo ""

# ========================================
# 清除 CDN 缓存
# ========================================
if [ -n "$CF_ZONE_ID" ] && [ -n "$CF_API_TOKEN" ]; then
    echo -e "  ${CYAN}清除 Cloudflare CDN 缓存...${NC}"

    PURGE_URLS=()
    for f in "${MANIFEST_DIR}"/*.json; do
        [ -f "$f" ] || continue
        PURGE_URLS+=("${DOWNLOAD_BASE_URL}/update/$(basename "$f")")
    done

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
    echo -e "  ${YELLOW}   强烈建议手动清除缓存以确保回滚立即生效!${NC}"
    echo ""
fi

# ========================================
# 验证
# ========================================
echo -e "  ${CYAN}验证回滚结果...${NC}"
echo ""

VERIFY_FAILED=0

for f in "${MANIFEST_DIR}"/*.json; do
    [ -f "$f" ] || continue
    FNAME=$(basename "$f")
    echo -n "    检查 ${FNAME}... "
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${DOWNLOAD_BASE_URL}/update/${FNAME}" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        REMOTE_VER=$(curl -s "${DOWNLOAD_BASE_URL}/update/${FNAME}" 2>/dev/null | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
        if [ "$REMOTE_VER" = "$TARGET_VERSION" ]; then
            echo -e "${GREEN}✓ v${REMOTE_VER}${NC}"
        else
            echo -e "${YELLOW}⚠️ 版本仍为 v${REMOTE_VER}（CDN 缓存未刷新?）${NC}"
            VERIFY_FAILED=1
        fi
    else
        echo -e "${RED}✗ (HTTP ${HTTP_CODE})${NC}"
        VERIFY_FAILED=1
    fi
done

echo ""

if [ $VERIFY_FAILED -eq 1 ]; then
    echo -e "${YELLOW}⚠️  部分验证未通过，可能是 CDN 缓存延迟，请稍后手动验证${NC}"
fi

# ========================================
# 完成
# ========================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ 回滚完成!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}已回滚到:${NC} v${TARGET_VERSION}"
echo ""
echo -e "  ${CYAN}手动验证命令:${NC}"
echo -e "    curl -s ${DOWNLOAD_BASE_URL}/update/latest.json | jq ."
echo -e "    curl -s ${DOWNLOAD_BASE_URL}/update/darwin-aarch64.json | jq ."
echo -e "    curl -s ${DOWNLOAD_BASE_URL}/update/windows-x86_64.json | jq ."
echo ""
