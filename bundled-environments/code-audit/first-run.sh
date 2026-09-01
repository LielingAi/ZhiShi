#!/usr/bin/env bash
# code-audit 首跑钩子（1.5.7 joern provision 化：joern 1.8GB 平台包移出镜像，
# 容器首跑时按需安装）。幂等可重放：已装跳过（command -v 守卫）+ flock 防
# 并发首跑重复下载。镜像内以 root 运行，不需要 sudo。
#
# 同步点（1.5.7）：下面的 joern 安装段与 provision.sh 的 joern 段是同一份
# 逻辑的两处内嵌——provision.sh 走 base64 传输必须自包含，无法 source 共享
# 文件。改一处必须同步另一处（差异仅在本脚本无需 sudo、非核心失败即 fatal
# 由调用方决定，provision.sh 则 WARN 不阻塞）。
set -euo pipefail

# GitHub 下载带公共镜像回落（与 provision.sh 的 gh_dl 同形态）。
gh_dl() { # gh_dl <release-url> <输出文件> <超时秒>
  local url="$1" out="$2" t="$3"
  curl -sSfL --max-time "$t" "$url" -o "$out" 2>/dev/null \
    || curl -sSfL --max-time "$t" "https://gh-proxy.com/$url" -o "$out" 2>/dev/null
}

# flock 防并发：多个会话同时首跑时只许一个安装，其余等待后走「已装跳过」。
exec 9>/tmp/zhishi-joern-install.lock
flock 9

if command -v joern >/dev/null 2>&1; then
  echo "[code-audit/first-run] joern 已装，跳过"
  exit 0
fi

# Joern（污点传播主力，多语言 CPG）。绕开 joern-install.sh 交互提示，
# 直接取 release 的 joern-cli 平台包解到 /opt/joern。
# 1.5.5（issue #7）：joern v4.x 起 release 资产改平台分包
# （joern-cli-<os>-<arch>.zip），裸 joern-cli.zip 已 404——按 uname -m 选包。
echo "[code-audit/first-run] installing joern（首次安装包约 1.8GB，耗时取决于网络）..."
case "$(uname -m)" in
  aarch64|arm64) JOERN_ASSET=joern-cli-linux-arm64.zip ;;
  *)             JOERN_ASSET=joern-cli-linux-x86_64.zip ;;
esac
gh_dl "https://github.com/joernio/joern/releases/latest/download/$JOERN_ASSET" /tmp/joern-cli.zip 900
rm -rf /opt/joern/joern-cli
unzip -q /tmp/joern-cli.zip -d /opt/joern
rm -f /tmp/joern-cli.zip
for b in joern joern-parse joern-scan joern-export joern-slice; do
  ln -sf "/opt/joern/joern-cli/$b" "/usr/local/bin/$b"
done

echo "[code-audit/first-run] joern installed: $(joern --version 2>&1 | head -1)"
