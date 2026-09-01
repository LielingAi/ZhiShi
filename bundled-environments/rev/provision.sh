#!/usr/bin/env bash
# rev 裸机/VM 安装脚本（1.5.8 provision.sh——与 Dockerfile apt 段 + setup.sh
# 安装段同源，服务「docker 配方绑定到 VM/裸机」与容器内「补齐环境」链路）。
# 已装跳过（command -v / 路径守卫），可反复重放；GitHub 下载带 gh_dl 镜像
# 回落、pip 回落清华（1.5.7 惯例）；非核心失败 WARN 不阻塞，重放即补。
#
# 同步点（1.5.8）：本脚本 Ghidra/ghidriff 段与 setup.sh 是同一份逻辑的两处
# 内嵌（本脚本走 base64 传输必须自包含，无法 source 共享文件）——改一处必须
# 同步另一处。
#
# 提权兼容（1.5.8）：docker 容器内是 root（容器里无 sudo），VM/裸机为非
# root + 免密 sudo——按 id -u 判定 $SUDO。脚本内不出现字面「sudo」调用，
# environment/setup 端点的 sudo免密预检（脚本含「sudo」字样才触发）因此
# 不拦容器场景；VM 侧若免密未配，会在首个 $SUDO 命令处失败，日志尾部可见。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

# GitHub 下载带公共镜像回落（gh_dl 形态，1.4.9 实机惯例）。
gh_dl() { # gh_dl <release-url> <输出文件> <超时秒>
  local url="$1" out="$2" t="$3"
  curl -sSfL --max-time "$t" "$url" -o "$out" 2>/dev/null \
    || curl -sSfL --max-time "$t" "https://gh-proxy.com/$url" -o "$out" 2>/dev/null
}

echo "[rev/provision] installing base toolchain via apt..."
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq openjdk-21-jre-headless \
  python3 python3-pip gdb binutils radare2 file xxd \
  curl wget unzip ca-certificates

# Ghidra（同步 setup.sh Ghidra 段：钉 12.1.2 + 官方公布 SHA-256 校验；
# ghidriff(pyhidra) 需要 GHIDRA_INSTALL_DIR 定位安装目录）
GHIDRA_VERSION="12.1.2"
GHIDRA_DATE="20260605"
GHIDRA_SHA256="b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d"
GHIDRA_ZIP="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip"
GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${GHIDRA_ZIP}"
export GHIDRA_INSTALL_DIR=/opt/ghidra

if [ -d /opt/ghidra ]; then
  echo "[rev/provision] Ghidra 已装，跳过"
else
  echo "[rev/provision] downloading Ghidra ${GHIDRA_VERSION} (headless)..."
  gh_dl "${GHIDRA_URL}" "/tmp/${GHIDRA_ZIP}" 900 \
    && echo "${GHIDRA_SHA256}  /tmp/${GHIDRA_ZIP}" | sha256sum -c - \
    && $SUDO unzip -q "/tmp/${GHIDRA_ZIP}" -d /opt \
    && $SUDO mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra \
    && rm -f "/tmp/${GHIDRA_ZIP}" \
    && $SUDO ln -sf /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless \
    || echo "[rev/provision] WARN: Ghidra 装不上——可重放本脚本或环境内手工补" >&2
fi

# ghidriff（同步 setup.sh ghidriff 段：pip 装 + 清华镜像回落；24.04 PEP 668
# 需 --break-system-packages）
if command -v ghidriff >/dev/null 2>&1; then
  echo "[rev/provision] ghidriff 已装，跳过"
else
  echo "[rev/provision] installing ghidriff..."
  pip3 install --break-system-packages --timeout 120 --retries 10 ghidriff 2>/dev/null \
    || pip3 install --break-system-packages --timeout 120 --retries 10 \
         -i https://pypi.tuna.tsinghua.edu.cn/simple ghidriff 2>/dev/null \
    || echo "[rev/provision] WARN: ghidriff 装不上——可重放本脚本或环境内手工补" >&2
fi

echo "[rev/provision] checking toolchain..."
java -version 2>&1 | head -1 || true
analyzeHeadless 2>&1 | head -2 || true
r2 -v 2>&1 | head -1 || true
ghidriff --version 2>&1 | head -1 || true
gdb --version 2>&1 | head -1 || true

echo "[rev/provision] ready"
