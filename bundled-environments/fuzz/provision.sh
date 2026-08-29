#!/usr/bin/env bash
# fuzz 裸机/VM 安装脚本（1.4.10 provision.sh——与 Dockerfile 同源，服务
# 「docker 配方绑定到 VM/裸机」的补齐链路）。纯 apt 系，天然幂等；
# 已装守卫只是省时间。需要：bash + sudo 免密（environment/setup 预检）。
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

echo "[fuzz/provision] installing toolchain via apt..."
sudo apt-get update -qq
sudo apt-get install -y -qq afl++ clang llvm build-essential \
  python3 python3-pip gdb git curl ca-certificates file xxd less

echo "[fuzz/provision] checking toolchain..."
afl-fuzz -h 2>&1 | head -1 || true
clang --version | head -1 || true
gdb --version | head -1 || true

# 插桩编译自检（与 fuzz-vm setup.sh 同款）：最小程序过一遍 afl-clang-fast。
if command -v afl-clang-fast >/dev/null 2>&1; then
  cat > /tmp/zhishi-afl-selfcheck.c <<'EOF'
#include <stdio.h>
int main(void){ char buf[8]; if (fgets(buf, sizeof buf, stdin)) puts(buf); return 0; }
EOF
  afl-clang-fast -g -O1 /tmp/zhishi-afl-selfcheck.c -o /tmp/zhishi-afl-selfcheck \
    && echo hi | /tmp/zhishi-afl-selfcheck >/dev/null \
    && echo "[fuzz/provision] afl-clang-fast 插桩自检通过" \
    || echo "[fuzz/provision] WARN: 插桩自检失败"
  rm -f /tmp/zhishi-afl-selfcheck /tmp/zhishi-afl-selfcheck.c
fi

echo "[fuzz/provision] ready"
