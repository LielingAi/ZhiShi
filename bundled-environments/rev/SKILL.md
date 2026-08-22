---
name: rev
description: 逆向工程环境。当任务是二进制逆向分析、固件解剖、恶意样本静态分析、补丁 diff 时使用——内置 Ghidra headless（analyzeHeadless 批处理反编译/脚本化分析）、ghidriff（patch diff,1day 刚需）、radare2（r2,快速静态面/脚本化）、gdb、binutils，大目标在环境内跑 headless 脚本，结果（反编译产物/符号/报告）落工作区。
base: docker
tools:
  - analyzeHeadless
  - ghidriff
  - r2
  - java
  - gdb
  - objdump
  - readelf
  - nm
  - python3
---

# rev —— 逆向工程环境

## 何时用

二进制逆向、固件分析、恶意样本静态分析、补丁 diff（patch diff）。Ghidra
以 **headless**（analyzeHeadless）形态使用——GUI 是研究员本机的事（D-边界
判断 #11：领域 GUI 不重做），环境内跑批处理与脚本化分析。

## 怎么进

```
zhishi env up rev
zhishi env open <id>
```

工作区挂载 `/workspace`，目标二进制放进来即可分析。

## 标准工作流

```bash
cd /workspace
# ① 快速静态面(r2 快手件:秒级出信息,Ghidra 分析前的侦察)
r2 -2 -qc 'iI; iS; iz' ./target.bin        # 基本信息/段/字符串
rabin2 -i ./target.bin                      # 导入表

# ② 建 Ghidra 工程并导入分析（headless）
analyzeHeadless /workspace/ghidra-proj MyProj -import ./target.bin \
  -analysisTimeoutPerFile 600 -deleteProject
# ③ 脚本化提取（反编译/函数清单/字符串）
analyzeHeadless /workspace/ghidra-proj MyProj -process ./target.bin \
  -scriptPath /workspace/scripts -postScript DecompileAll.java

# ④ 补丁 diff(1day:新旧两版直接 diff,markdown/json 报告落盘)
ghidriff ./old.bin ./new.bin -o /workspace/out/patch-diff
```

补丁 diff 套路：优先 `ghidriff` 一把梭（VersionTrackingDiff 直接出函数级
改动清单）；要自定义关联再退回 analyzeHeadless 分别导出反编译 → 文本 diff。
锁到改动函数后 gdb 动态验证（需要跑起来时换 pwn 配方环境）。

## 结果怎么采

反编译产物/ghidriff 报告/脚本输出约定落 `/workspace/out/`；分析结论用
`zhishi research log` 记录（task_kind=re 之类按实际），蒸馏弧沉淀。

## 怎么收尾

`zhishi env down <id>`。Ghidra 工程想留：留 `/workspace/ghidra-proj/`
（工作区内的东西 docker rm 不丢）。
