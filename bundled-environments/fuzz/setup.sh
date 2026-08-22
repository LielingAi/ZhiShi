#!/usr/bin/env bash
# fuzz 环境初始化与自检
set -euo pipefail

echo "[fuzz-env] checking toolchain..."
afl-fuzz -h 2>&1 | head -1 || true
command -v afl-clang-fast afl-fuzz afl-tmin afl-cmin afl-showmap >/dev/null
clang --version | head -1
llvm-symbolizer --version | head -1   # ASan 报告符号化(崩溃研判用)

# 插桩编译自检：最小程序过一遍 afl-clang-fast
cat > /tmp/zhishi-afl-selfcheck.c <<'EOF'
#include <stdio.h>
int main(void){ char buf[8]; if (fgets(buf, sizeof buf, stdin)) puts(buf); return 0; }
EOF
afl-clang-fast -g -O1 /tmp/zhishi-afl-selfcheck.c -o /tmp/zhishi-afl-selfcheck
echo hi | /tmp/zhishi-afl-selfcheck >/dev/null
rm -f /tmp/zhishi-afl-selfcheck /tmp/zhishi-afl-selfcheck.c

# libFuzzer 自检：clang 自带 -fsanitize=fuzzer（无需额外安装件），
# 编译+短跑一个最小 harness 确认链路可用；示例 harness 见
# /opt/zhishi/examples/libfuzzer-harness.c
cat > /tmp/zhishi-lf-selfcheck.c <<'EOF'
#include <stdint.h>
#include <stddef.h>
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size >= 4 && data[0]=='F' && data[1]=='U' && data[2]=='Z' && data[3]=='Z') __builtin_trap();
  return 0;
}
EOF
clang -g -O1 -fsanitize=fuzzer,address /tmp/zhishi-lf-selfcheck.c -o /tmp/zhishi-lf-selfcheck
mkdir -p /tmp/zhishi-lf-corpus && /tmp/zhishi-lf-selfcheck -runs=1000 /tmp/zhishi-lf-corpus >/dev/null 2>&1
rm -rf /tmp/zhishi-lf-selfcheck /tmp/zhishi-lf-selfcheck.c /tmp/zhishi-lf-corpus

echo "[fuzz-env] ready"
