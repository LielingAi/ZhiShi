---
kind: technique
title: 示例条目：栈溢出 triage 的最小路径（smoke 占位，待主代理替换）
applicability: 仅用于 1.2.1 骨架期 seed 机制 smoke 验证——真实内容待首批选题替换；二进制域拿到崩溃现场不知道先看什么时的最小处置路径示例。
criteria: smoke 断言：seed 后 expert.db 存在该条目且 FTS 可按「栈溢出」命中；真实使用时按「10 分钟内定位到崩溃指令与可控寄存器」判定用对。
tags: 示例,smoke,栈溢出
---

> 这是 1.2.1 骨架期的 smoke 占位条目（示例），用于验证 seed/检索/审定链路，
> 内容深度不代表库的标准——首批真实条目由主代理按 dogfood 亲历卡点替换。

## 最小路径

1. 复现崩溃，拿到信号与上下文（`gdb ./target core` 或 `run < poc`）。
2. `info registers` 看 rip/eip 是否可控；可控 → 直接进利用路径评估。
3. 不可控 → `bt` 看栈帧，定位溢出点函数，回到源码核对拷贝长度。
4. 检查防护：`checksec`（canary / NX / PIE / RELRO），决定后续利用策略。

## 判据

- 10 分钟内说清：崩溃指令、可控寄存器集、防护清单。
- 说不清 = 没走完这条路径，回到第 1 步。
