---
kind: sop
title: 崩溃研判四步——去重、根因、可控性、bug_class 归类
applicability: fuzz 产出崩溃/手上有 crash dump 需要研判归类时——先判「是不是真问题、可不可控」，再决定投不投入。
criteria: 崩溃按站点 hash 去重后再研判；能答出：fault 地址与值（像不像输入数据）、PC 是否可控、bug_class 归类（选不准就 other 不硬套）；结论结构化落 research_log。
tags: 崩溃研判,crash-triage,SIGSEGV,backtrace,bug_class,cyclic
---

## 流程

1. **去重**：按 crash 站点 hash 归并（信号类型 + 顶帧地址/符号）——同一站点的一万个崩溃是一个 bug，先 dedupe 再研判。
2. **根因初判（三样证据）**：
   - 信号类型：SIGSEGV（非法读写/执行）/ SIGABRT（堆检查、assert）/ SIGILL / SIGFPE（除零、整数溢出陷阱）各指不同 bug 类；
   - 寄存器：`info registers`——fault 地址落在哪、值是否像输入数据（0x41414141、cyclic pattern）；
   - backtrace 前 5 帧：顶帧在 memcpy/free/堆分配器/解析器各有不同含义。
3. **可控性判断（决定危害等级与是否继续）**：fault 地址是否被输入控制？PC 是否可控（能控 PC 就是可利用苗头，优先级拉满）？cyclic 当输入复现，`cyclic -l` 量化可控偏移。
4. **bug_class 归类**：stack-overflow / heap-overflow / uaf / double-free / oob-read / oob-write / null-deref（fault 近 0x0~0x1000）/ int-overflow / format-string / type-confusion / other（选不准就 other，不硬套）。

## 判据

- 研判结论必须结构化落 research_log（outcome + bug_class + 摘要）——自由文本里的结论蒸馏吃不到，等于白研判。
