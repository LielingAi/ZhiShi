---
name: fuzz
description: 模糊测试（fuzzing）环境。当任务是漏洞挖掘、崩溃复现、fuzz harness 编写与长跑 fuzz 时使用——内置 AFL++ 全家（afl-clang-fast/afl-fuzz/afl-tmin/afl-cmin），语料与崩溃按目录约定经工作区进出，适合小时级后台 fuzz + 崩溃收集研判。
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

## 结果怎么采

`corpus-out/` 全在工作区：crashes 目录就是成果。研判结论用 `zhishi research log` 记录（outcome/bug_class），蒸馏弧按域沉淀。

## 怎么收尾

`zhishi env down <id>`。长跑 fuzz 想留现场续跑：`docker commit` 存镜像，下次起新容器接着挂 corpus-out。
