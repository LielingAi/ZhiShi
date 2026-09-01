#!/usr/bin/env bash
# fuzz 环境初始化与自检
# 1.5.8 分层容错：afl++/llvm/clang 全在 apt 基本盘（安装层 fail-fast 不变），
# 但插桩/libFuzzer 自检属功能验证——构建环境跑不动插桩编译不该中断整个构建，
# 降级为警告不退出；核心编译器（clang）自检保持 fatal。
set -euo pipefail

echo "[fuzz-env] checking toolchain..."
afl-fuzz -h 2>&1 | head -1 || true
command -v afl-clang-fast afl-fuzz afl-tmin afl-cmin afl-showmap >/dev/null \
  || echo "[zhishi] WARN: afl++ 工具缺失——构建继续，环境内可用『补齐环境』补装" >&2
clang --version | head -1
llvm-symbolizer --version | head -1   # ASan 报告符号化(崩溃研判用)

# 插桩编译自检：最小程序过一遍 afl-clang-fast
# 1.5.8：自检失败降级 WARN（WARN 行带工具名，能力探测 miss 时可对照）
if command -v afl-clang-fast >/dev/null 2>&1; then
  cat > /tmp/zhishi-afl-selfcheck.c <<'EOF'
#include <stdio.h>
int main(void){ char buf[8]; if (fgets(buf, sizeof buf, stdin)) puts(buf); return 0; }
EOF
  afl-clang-fast -g -O1 /tmp/zhishi-afl-selfcheck.c -o /tmp/zhishi-afl-selfcheck \
    && echo hi | /tmp/zhishi-afl-selfcheck >/dev/null \
    || echo "[zhishi] WARN: afl-clang-fast 插桩自检失败——构建继续，环境内可复跑自检" >&2
  rm -f /tmp/zhishi-afl-selfcheck /tmp/zhishi-afl-selfcheck.c
fi

# libFuzzer 自检：clang 自带 -fsanitize=fuzzer（无需额外安装件），
# 编译+短跑一个最小 harness 确认链路可用；示例 harness 见
# /opt/zhishi/examples/libfuzzer-harness.c
# 1.5.8：自检失败降级 WARN
cat > /tmp/zhishi-lf-selfcheck.c <<'EOF'
#include <stdint.h>
#include <stddef.h>
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size >= 4 && data[0]=='F' && data[1]=='U' && data[2]=='Z' && data[3]=='Z') __builtin_trap();
  return 0;
}
EOF
clang -g -O1 -fsanitize=fuzzer,address /tmp/zhishi-lf-selfcheck.c -o /tmp/zhishi-lf-selfcheck \
  && mkdir -p /tmp/zhishi-lf-corpus \
  && /tmp/zhishi-lf-selfcheck -runs=1000 /tmp/zhishi-lf-corpus >/dev/null 2>&1 \
  || echo "[zhishi] WARN: libFuzzer 自检失败——构建继续，环境内可复跑自检" >&2
rm -rf /tmp/zhishi-lf-selfcheck /tmp/zhishi-lf-selfcheck.c /tmp/zhishi-lf-corpus

echo "[fuzz-env] ready"
