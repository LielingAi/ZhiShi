---
name: fuzz
description: 模糊测试（fuzzing）环境。当任务是漏洞挖掘、崩溃复现、fuzz harness 编写与长跑 fuzz 时使用——内置 AFL++ 全家（afl-clang-fast/afl-fuzz/afl-tmin/afl-cmin）+ libFuzzer（clang 自带 -fsanitize=fuzzer，库内目标 in-process fuzz，示例 harness 见 /opt/zhishi/examples/libfuzzer-harness.c）+ sanitizers（ASan/UBSan，llvm-symbolizer 符号化报告），语料与崩溃按目录约定经工作区进出，适合小时级后台 fuzz + 崩溃收集研判。
base: docker
tools:
  - afl-clang-fast
  - afl-clang-lto
  - afl-gcc
  - afl-fuzz
  - afl-tmin
  - afl-cmin
  - afl-showmap
  - clang
  - gcc
  - llvm-symbolizer
  - python3
  - gdb
---

# fuzz —— 模糊测试环境

## 何时用

漏洞挖掘（fuzz 找崩溃）、崩溃复现与最小化、fuzz harness 编写。**长跑 fuzz 是常态**——小时级任务放后台（subagent/CronTask），主会话不阻塞。

## 怎么进

```
zhishi env up fuzz
zhishi env open <id>       # 或 docker exec -it <container> bash
```

工作区挂载 `/workspace`。语料目录约定：

```
/workspace/corpus-in/     # 种子语料（你提供）
/workspace/corpus-out/    # afl-fuzz 输出（crashes/hangs/queue 都在这里）
```

## 标准工作流

```bash
cd /workspace
# ① 写 harness（从 stdin/文件读输入喂目标函数）
# ② 插桩编译
afl-clang-fast -g -O1 harness.c target.c -o fuzz_target
# ③ 跑 fuzz
afl-fuzz -i corpus-in -o corpus-out -- ./fuzz_target @@
# ④ 崩溃研判
ls corpus-out/default/crashes/
gdb ./fuzz_target corpus-out/default/crashes/id\:000000*   # 看崩溃现场
afl-tmin -i <crash> -o crash-min -- ./fuzz_target @@       # 最小化
```

- 崩溃去重与根因初判交给 `crash-triager`；长跑 fuzz 交给 `fuzz-runner`（subagent，后台跑、结构化回报）。
- `AFL_SKIP_CPUFREQ=1`、`AFL_I_DONT_CARE_ABOUT_MISSING_CRASHES=1` 在容器里通常需要。

## 非默认开关取舍（何时开、为什么）

默认 `afl-fuzz -i corpus-in -o corpus-out -- ./fuzz_target @@` 能覆盖大多数场景。以下开关**按需启用**，不是默认——开之前先确认场景命中：

| 开关 | 何时开 | 代价 | 备注 |
|---|---|---|---|
| **cmplog**（`-c <cmplog_bin>`） | 输入有魔数/校验和/长度字段等"比较关卡"卡住变异时（lz4/png/tcpdump 类格式）。需先用 `afl-clang-lto -c`（或 `AFL_LLVM_CMPLOG=1`）额外编一个 cmplog 版二进制 | 多编一次目标 | AFL++ 的比较日志求解器，自动解出比较常量。只有"有源码且能 lto 构建"才可用 |
| **字典 `-x <file.dict>`** | 输入是结构化文本格式（JSON/XML/SQL/HTTP 等），关键词命中能显著提速 | 几乎为零 | Debian 的 afl++ 包不带官方字典（上游仓库 `dictionaries/` 有）；也可以按目标格式自写十几行关键词 |
| **libFuzzer `-use_value_profile=1`** | 用 libFuzzer 跑库内目标时 | 几乎为零 | 值覆盖信号——覆盖之外的"数据流"信息，对解析器类目标建议默认开（写进 harness 编译命令） |
| **LAF-Intel / MOpt（`-L`）** | **暂不采用** | — | LAF-Intel 拆分比较有收益争议且改变目标语义；MOpt 调度未在本环境对照过静态权重基线（Fuzzillai 的 Thompson Sampling 实验同样未完成这个对照）。要用先做单目标 A/B，别默认开 |

判断"比较关卡卡住"的信号：fuzzer_stats 里 execs 很多但 paths 长期不涨（ plateau ），且目标格式已知含魔数/校验字段——这时优先考虑 cmplog，不是换种子。

## libFuzzer（库内目标,in-process fuzz）

目标是库函数/解析器而不是独立二进制时,libFuzzer 比 AFL++ 快一个量级——
clang 自带 `-fsanitize=fuzzer`，零安装件。示例 harness（照它改写）:
`/opt/zhishi/examples/libfuzzer-harness.c`。

```bash
# ① 编译(LLVMFuzzerTestOneInput 是唯一契约)
clang -g -O1 -fsanitize=fuzzer,address harness.c target.c -o fuzz_lf
# ② 跑(语料目录即输入即输出;崩溃 artifact 落 artifact_prefix)
./fuzz_lf corpus-lf/ -max_total_time=3600 -artifact_prefix=crashes-lf/
# ③ 崩溃复现/最小化:同一二进制就是 reproducer
./fuzz_lf crashes-lf/crash-*
./fuzz_lf -minimize_crash=1 -runs=100000 crashes-lf/crash-*
```

ASan 报告解读：`ASAN_SYMBOLIZER_PATH=$(which llvm-symbolizer)`（环境已装，
默认能找到）；报告里 `SUMMARY: AddressSanitizer: heap-buffer-overflow` 行
就是 bug_class 判定起点，堆栈帧经 llvm-symbolizer 符号化后直接可读。

## 结果怎么采

`corpus-out/` 全在工作区：crashes 目录就是成果。研判结论用 `zhishi research log` 记录（outcome/bug_class），蒸馏弧按域沉淀。

## 怎么收尾

`zhishi env down <id>`。长跑 fuzz 想留现场续跑：`docker commit` 存镜像，下次起新容器接着挂 corpus-out。
