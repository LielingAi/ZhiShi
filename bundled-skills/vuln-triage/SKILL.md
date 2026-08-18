---
name: vuln-triage
description: 崩溃研判方法。当 fuzz 跑出崩溃、手上有 crash dump/崩溃现场需要分析归类时使用——崩溃去重（按 crash 站点 hash：信号 + 顶帧地址/符号）、根因初判（信号类型/寄存器/backtrace 前 5 帧）、可控性判断（crash 地址与 PC 可控性）、bug_class 归类（stack-overflow/heap-overflow/uaf/double-free/oob-read/oob-write/null-deref/int-overflow/format-string/type-confusion/other），结论经 `zhishi research log` 结构化记录（outcome + bug_class）作为蒸馏原料。
author: ZhiShi
---

# vuln-triage —— 崩溃研判与 bug_class 归类

## 流程

1. **去重**：按 crash 站点 hash 归并——**信号类型 + 顶帧地址/符号** 组合做 key。同一站点的一万个崩溃是一个 bug，不是一万个；先 dedupe 再研判，避免重复劳动淹没真问题。
2. **根因初判**：三样证据——
   - **信号类型**：SIGSEGV（读/写/执行非法地址）/ SIGABRT（堆检查、assert）/ SIGILL / SIGFPE（除零、整数溢出陷阱）各指向不同 bug 类。
   - **寄存器状态**：crash 时 `info registers`——fault 地址落在哪、值是否像输入数据（0x41414141、cyclic pattern）。
   - **backtrace 前 5 帧**：`bt` 看调用路径，顶帧在 memcpy/free/堆分配器/解析器各有不同含义。5 帧以内通常足够定位责任代码，不够再往下看。
3. **可控性判断**（决定危害等级，也决定值不值得继续挖）：
   - crash 地址（fault address）是否被输入控制？
   - PC（指令指针）是否可控——能控 PC 就是可利用苗头，优先级拉满。
   - 用 cyclic pattern 当输入复现，`cyclic -l` 直接量化可控偏移。
4. **bug_class 归类**：从以下枚举选（选不准就 `other`，不要硬套）：

   | bug_class | 典型特征 |
   |---|---|
   | stack-overflow | 栈写穿，覆盖返回地址/Canary |
   | heap-overflow | 堆块越界写，破坏相邻块元数据 |
   | uaf | free 后继续使用，顶帧常在堆操作 |
   | double-free | SIGABRT + 分配器报 double free |
   | oob-read | 越界读，常表现为 info leak 或读到非法地址 SIGSEGV |
   | oob-write | 越界写，fault 地址在写指令、值常可控 |
   | null-deref | fault 地址近 0（0x0~0x1000），多为缺检查 |
   | int-overflow | 整数回绕导致分配/索引失真，常是后续越界的前因 |
   | format-string | 格式化函数顶帧 + 输入含 `%` 直达 |
   | type-confusion | 对象按错误类型解释，vtable/字段访问错乱 |
   | other | 以上都不像，备注实际特征 |

## 产出纪律

研判结论必须**结构化记录**，不是聊完就散：

```bash
zhishi research log   # 记录 outcome（success/fail/stuck）+ bug_class + 结论摘要
```

这是蒸馏弧的原料——「这个 crash 是什么类、可不可控、卡在哪」进了 research_events，后续的漏洞挖掘经验才能沉淀。自由文本里的结论蒸馏吃不到，等于白研判。
