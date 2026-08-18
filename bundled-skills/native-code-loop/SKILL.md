---
name: native-code-loop
description: 编译-运行-调试闭环方法。当任务要写、编译、运行或调试任何 C/C++/汇编/Python 代码时使用——exploit、PoC、fuzz harness、补丁复现、算法验证全都算。核心纪律：宿主零工具链，代码用 Write/Edit 落在工作区，编译运行全部在 zhishi 环境（`zhishi env up dev` 等配方）内进行，崩溃进 gdb 迭代。也覆盖构建失败排错、环境内缺工具自装并沉淀回配方、exploit 试错时主动用会话 fork/rewind 回思路 + 环境快照回现场。
author: ZhiShi
---

# native-code-loop —— 编译-运行-调试闭环

## 核心原则：宿主零工具链

**宿主机器上没有任何编译器/调试器，也不要装。** 一切编译、运行、调试都在 zhishi 环境里进行；宿主的唯一职责是放代码（工作区）和看结果。

## 闭环流程

1. **起环境**：`zhishi env up dev`（通用原生开发；如果会话已选好其他环境/配方，用当前环境，不要另起）。首次构建镜像要几分钟，之后秒起。
2. **写代码在工作区**：用 SDK 的 Write/Edit 工具直接写工作区文件——**不要**经环境 shell 绕路（heredoc 进容器、容器内 vim 之类），那样代码脱离工作区、无法被宿主侧追踪和归档。
3. **环境内编译运行**：工作区自动挂载在环境内 `/workspace`，环境内直接：

   ```bash
   cd /workspace
   clang -g -O0 x.c -o x   # 调试期一律 -g -O0；性能/release 验证才换 -O2
   ./x
   ```

   Python 同理：`python3 script.py`，缺包 `pip3 install <pkg>`（装在环境内，不污染宿主）。
4. **崩溃进 gdb**：`gdb ./x` → `run` → 崩了 `bt`（backtrace）+ `info registers` 看现场 → 定位 → 回第 2 步改代码。core dump 用 gdb 里 `generate-core-file` 直接留在 `/workspace`。
5. **迭代**：改代码（工作区）→ 环境内重编译 → 重跑。循环直到行为符合预期。

## 试错回滚（exploit 迭代专用）

exploit 开发是高频试错场景，走死胡同不要硬堆上下文：

- **回思路**：当前思路证伪时，主动建议用户用会话 **fork/rewind** 回到分叉点换条路走，而不是在错误方向上继续叠加尝试。
- **回现场**：环境侧现场用快照回滚——容器 `docker commit <container> <tag>` 留快照；VM 走 hypervisor 快照。回到干净/已知现场再试下一招。

## 产物纪律

- **一切成果落工作区**：源码、编译产物、崩溃转储、运行日志、exp 脚本——全部在 `/workspace`（即宿主工作区）。长任务输出重定向到 `/workspace/logs/`。
- **环境是一次性的**：用完 `zhishi env down <id>` 销毁，环境销毁不带走任何东西。任何"只留在容器内路径"的成果等于没做。

## 排错

- **构建失败**：读 build 日志定位缺什么，修配方或修代码——不要在宿主编译"试一下"。
- **环境内缺工具**：环境内 `apt install` / `pip install` 自装，继续干活；**验证有效的变更要沉淀回配方**——把 install 命令写回 `~/.zhishi/environments/<recipe>/` 的 `Dockerfile` / `setup.sh`，下次重建镜像自带。只装不沉淀，同一个坑会反复踩。
