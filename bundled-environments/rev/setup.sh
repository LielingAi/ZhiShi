#!/usr/bin/env bash
# rev 环境初始化与自检（Ghidra headless 按需下载，sha256 校验——D-T2）
set -euo pipefail

# Ghidra 12.1.2（GitHub release 2026-06-05，官方公布 SHA-256）
GHIDRA_VERSION="12.1.2"
GHIDRA_DATE="20260605"
GHIDRA_SHA256="b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d"
GHIDRA_ZIP="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip"
GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${GHIDRA_ZIP}"

echo "[rev-env] downloading Ghidra ${GHIDRA_VERSION} (headless)..."
if [ ! -d /opt/ghidra ]; then
  wget -q "${GHIDRA_URL}" -O "/tmp/${GHIDRA_ZIP}"
  echo "${GHIDRA_SHA256}  /tmp/${GHIDRA_ZIP}" | sha256sum -c -
  unzip -q "/tmp/${GHIDRA_ZIP}" -d /opt
  mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra
  rm -f "/tmp/${GHIDRA_ZIP}"
  ln -sf /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless
fi

echo "[rev-env] checking toolchain..."
java -version 2>&1 | head -1
analyzeHeadless 2>&1 | head -2 || true
gdb --version | head -1

echo "[rev-env] ready"
