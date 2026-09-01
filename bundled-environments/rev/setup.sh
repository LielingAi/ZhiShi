#!/usr/bin/env bash
# rev 环境初始化与自检（Ghidra headless 按需下载，sha256 校验——D-T2）
# 1.5.8 分层容错：Ghidra 下载/ghidriff pip 属功能层——失败降级 WARN 不中断
# 构建（缺失由能力探测报 miss，环境内走「补齐环境」重放 provision.sh 补装）；
# 自检分两类——apt 基本盘（java/r2/gdb）保持 fatal，功能工具只警告不退出。
set -euo pipefail

# Ghidra 12.1.2（GitHub release 2026-06-05，官方公布 SHA-256）
GHIDRA_VERSION="12.1.2"
GHIDRA_DATE="20260605"
GHIDRA_SHA256="b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d"
GHIDRA_ZIP="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip"
GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${GHIDRA_ZIP}"

echo "[rev-env] downloading Ghidra ${GHIDRA_VERSION} (headless)..."
if [ ! -d /opt/ghidra ]; then
  # 1.5.7：下载失败回落 gh-proxy.com（gh_dl 形态）
  # 1.5.8：下载/校验/解压任一失败降级 WARN，不中断构建
  ( wget -q "${GHIDRA_URL}" -O "/tmp/${GHIDRA_ZIP}" \
    || wget -q "https://gh-proxy.com/${GHIDRA_URL}" -O "/tmp/${GHIDRA_ZIP}" ) \
  && echo "${GHIDRA_SHA256}  /tmp/${GHIDRA_ZIP}" | sha256sum -c - \
  && unzip -q "/tmp/${GHIDRA_ZIP}" -d /opt \
  && mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra \
  && rm -f "/tmp/${GHIDRA_ZIP}" \
  && ln -sf /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless \
  || echo "[zhishi] WARN: ghidra 安装失败——构建继续，环境内可用『补齐环境』补装" >&2
fi

echo "[rev-env] installing ghidriff (patch diff,1day 刚需)..."
# ghidriff 是 pip 包 + 独立 CLI（经 pyhidra 驱动本机 Ghidra；
# GHIDRA_INSTALL_DIR 已在 Dockerfile 里 ENV 固定到 /opt/ghidra）。
# ubuntu 24.04 有 PEP 668,系统级 pip 必须 --break-system-packages。
# 1.5.7：失败回落清华镜像。1.5.8：回落也失败降级 WARN，不中断构建。
pip3 install --break-system-packages --no-cache-dir ghidriff \
  || pip3 install --break-system-packages --no-cache-dir \
       -i https://pypi.tuna.tsinghua.edu.cn/simple ghidriff \
  || echo "[zhishi] WARN: ghidriff 安装失败——构建继续，环境内可用『补齐环境』补装" >&2

echo "[rev-env] checking toolchain..."
# 核心（apt 基本盘）自检：失败即非零退出，构建期暴露问题
java -version 2>&1 | head -1
r2 -v | head -1
gdb --version | head -1
# 功能工具自检：只警告不退出（1.5.8——WARN 行带工具名，能力探测 miss 时可对照）
command -v analyzeHeadless >/dev/null 2>&1 \
  || echo "[zhishi] WARN: ghidra(analyzeHeadless) 缺失——环境内可用『补齐环境』补装" >&2
ghidriff --version 2>&1 | head -1 \
  || echo "[zhishi] WARN: ghidriff 自检失败——环境内可用『补齐环境』补装" >&2

echo "[rev-env] ready"
