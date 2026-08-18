#!/usr/bin/env bash
# fuzz-vm 环境初始化与自检 —— 在 guest（Ubuntu Server）内运行
set -euo pipefail

echo "[fuzz-vm] installing toolchain via apt..."
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential clang gdb python3 python3-pip git

echo "[fuzz-vm] installing AFL++..."
if ! command -v afl-fuzz >/dev/null 2>&1; then
  if apt-cache show aflplusplus >/dev/null 2>&1; then
    sudo apt-get install -y -qq aflplusplus
  else
    # 源里没有就源码装（Ubuntu 24.04 源带 aflplusplus，正常走不到这里）
    git clone --depth 1 https://github.com/AFLplusplus/AFLplusplus "$HOME/AFLplusplus"
    (cd "$HOME/AFLplusplus" && make -j"$(nproc)" && sudo make install)
  fi
fi

echo "[fuzz-vm] checking toolchain..."
afl-fuzz -h 2>&1 | head -1 || true
command -v afl-clang-fast afl-fuzz afl-tmin afl-cmin afl-showmap >/dev/null
clang --version | head -1

# 插桩编译自检：最小程序过一遍 afl-clang-fast
cat > /tmp/zhishi-afl-selfcheck.c <<'EOF'
#include <stdio.h>
int main(void){ char buf[8]; if (fgets(buf, sizeof buf, stdin)) puts(buf); return 0; }
EOF
afl-clang-fast -g -O1 /tmp/zhishi-afl-selfcheck.c -o /tmp/zhishi-afl-selfcheck
echo hi | /tmp/zhishi-afl-selfcheck >/dev/null
rm -f /tmp/zhishi-afl-selfcheck /tmp/zhishi-afl-selfcheck.c

echo "[fuzz-vm] ready —— adopt/build 收尾会自动做 zhishi-clean 快照"
