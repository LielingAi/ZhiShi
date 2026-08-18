#!/usr/bin/env bash
# fuzz 环境初始化与自检
set -euo pipefail

echo "[fuzz-env] checking toolchain..."
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

echo "[fuzz-env] ready"
