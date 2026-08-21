---
kind: sop
title: 栈溢出从崩溃到控制流的最小判定链
applicability: 二进制域拿到崩溃现场（SIGSEGV/SIGABRT、core dump、fuzz 产出 crash 文件），需要在 10 分钟内判断「能不能控 rip/eip、值不值得继续」时。
criteria: 能明确答出三个问题：崩溃指令是什么、哪些寄存器被输入控制、防护清单（canary/NX/PIE/RELRO）——答不齐就是没走完。
tags: 栈溢出,checksec,cyclic,控制流
---

## 判定链

1. **复现并定位崩溃点**：`gdb ./target` → `run < poc`；崩溃时 `x/i $pc` 看崩溃指令。
2. **可控性判定**：`info registers`——rip/eip 或 rsp/esp 内容是否为输入片段（输入用 `cyclic 200` 生成，`cyclic -l <值>` 反查偏移）。rip 可控 → 直接进利用路径；仅栈内容可控 → 看返回地址覆盖偏移。
3. **防护清单**（决定利用策略，先查再选路）：
   - `checksec --file=./target`
   - canary off + NX on + PIE off → ret2win/ret2plt 直接返到目标函数
   - canary on → 先找信息泄露原语，无泄露则评估放弃
   - PIE on → 需要地址泄露才能定 gadgets
4. **验证**：写最小 exp（pwntools）让 rip 精确落到 `0xdeadbeef` 之类的哨兵地址——崩在哨兵上 = 控制流实锤。

## 判据

- 崩在哨兵地址（`0xdeadbeef` 出现在 rip）= 控制流确认，可以进原语规划。
- 偏移反查不出来 = 输入没到达返回地址，回头查拷贝路径（gets/strcpy/截断）。
