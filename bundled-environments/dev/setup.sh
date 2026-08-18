#!/usr/bin/env bash
# dev 环境初始化与自检：验证工具链可用，失败即非零退出（构建期暴露问题）
set -euo pipefail

echo "[dev-env] checking toolchain..."
clang --version | head -1
gcc --version | head -1
python3 --version
gdb --version | head -1
make --version | head -1

echo 'int main(void){return 0;}' > /tmp/zhishi-selfcheck.c
clang /tmp/zhishi-selfcheck.c -o /tmp/zhishi-selfcheck
/tmp/zhishi-selfcheck
rm -f /tmp/zhishi-selfcheck /tmp/zhishi-selfcheck.c

echo "[dev-env] ready"
