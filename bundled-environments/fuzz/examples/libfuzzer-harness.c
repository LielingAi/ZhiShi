// libFuzzer 示例 harness —— 库内目标（in-process fuzz）的标准写法。
//
// 与 AFL++ 的分工：AFL++ 适合独立二进制（forkserver，语料走文件/stdin）；
// libFuzzer 适合库函数/解析器（进程内循环，速度快一个量级，语料在内存）。
// clang 自带 -fsanitize=fuzzer，无需额外安装件。
//
// 用法：
//   clang -g -O1 -fsanitize=fuzzer,address libfuzzer-harness.c target.c -o fuzz_lf
//   ./fuzz_lf corpus-in/ -max_total_time=3600 -artifact_prefix=crashes/
//   # 崩溃复现:  ./fuzz_lf crashes/crash-*           （同一二进制即 reproducer）
//   # 最小化:    ./fuzz_lf -minimize_crash=1 -runs=100000 crashes/crash-*
//
// 改写时只需替换 parse_target() 为被测函数；data/size 是唯一输入契约。

#include <stdint.h>
#include <stddef.h>
#include <string.h>

// 被测函数桩：换成真实目标（解析器/解码器/协议处理函数）
static void parse_target(const uint8_t *data, size_t size) {
  // 示例：一个会在 "FUZZ" 前缀下崩的假目标
  if (size >= 4 && memcmp(data, "FUZZ", 4) == 0) {
    volatile char *p = (char *)0;
    *p = 1;
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size == 0) return 0;
  parse_target(data, size);
  return 0;
}
