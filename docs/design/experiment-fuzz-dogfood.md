# 1.6.7 #6 — fuzz dogfood 实验报告（端到端挖掘链路首跑）

> 日期：2026-09-09。性质：**实验不是验收门**——1.6.7 立项时拍板「它怎么死、
> 死在哪，就是 1.6.8 战役原语的一手需求」（零负样本不画架构图，1.6.1 纪律）。
> 基底：1.6.1 的注入靶（cJSON v1.7.18 + 同根因兄弟 bug 对 escape_track /
> key_audit，定长全局缓冲写入无边界检查），fuzz 配方 docker 镜像实跑。

## 1. 实验设置

- 环境：`zhishi-env-fuzz:dogfood`（bundled-environments/fuzz 配方镜像，本机 docker）；
- 目标：`tmp/exp-crash-variant/target/`（harness.c + 注入 bug 的 cJSON.c）+ 4 个种子；
- 链路段：构建（afl-clang-fast + ASan）→ AFL 长跑 → 崩溃捕获 → stack-hash 去重指纹。

## 2. 结果明账

| 链路段 | 结果 | 证据 |
|---|---|---|
| ASan 构建 | **首跑即炸**（配方坑①）→ 修复后过 | `libclang_rt.asan-*.a` 缺失，链接失败 |
| AFL 盲跑 100s | 20,396 execs / 204 e·s⁻¹ / 16.42% 覆盖 / **0 崩溃** | fuzzer_stats |
| AFL 盲跑 600s | 120,995 execs / 202 e·s⁻¹ / **0 崩溃** | fuzzer_stats |
| 引导触发（定向构造 8 万 `\u0041` 转义） | **秒级命中** | ASan global-buffer-overflow |
| stack-hash 指纹 | 首跑顶帧为空（配方坑②）→ 修复后**符号化精确命中注入站点** | `asan:global-buffer-overflow \| #0 in utf16_literal_to_utf8 cJSON.c:733:40`；种子样本正确判 no-crash |

## 3. 配方坑（dogfood 的实证产出，已修，dea51d1）

1. **ASan 运行时缺失**：afl-clang-fast 在 ubuntu 24.04 挂 llvm-17，配方没装
   `libclang-rt-17-dev`——`-fsanitize=address` 开箱即炸。 fuzz 配方的「ASan
   构建」形态从未被实证过（1.6.1 的实验环境是手工装的）；
2. **符号化器缺失**：`llvm-symbolizer` 不在镜像——ASan 只打裸地址，
   stack-hash 顶帧站点为空，崩溃去重粒度退化到「只有 bug 类」。这正是轨迹
   分析里 capabilityMissing 常含 llvm-symbolizer 的兑现。

## 4. 挖掘侧的核心数据点（1.6.8 设计输入）

**盲变异 121k 次执行摸不到注入 bug；引导触发秒级命中。** 与 1.6.1 的对照
实验互证（LLM 变体深挖 63s vs afl-tmin 愚蠢回灌 23.2min）：

- 「撑爆定长缓冲」这类 bug 的触发条件是**结构语义**（转义计数 vs 声明上限），
  盲变异的字节扰动在 JSON 文法约束下命中概率指数级低——覆盖率反馈引导的是
  「文法内的路径探索」，不是「语义阈值突破」；
- 结论：**挖掘的第一变量是引导（guidance），不是算力**。战役原语的核心不该
  是「把 fuzz 跑起来」，而是「盲跑信号（覆盖率平台期/无崩溃）→ 触发引导回路
  （读源码 → 假设 → 定向构造/变体深挖 → 回灌语料）」的事件驱动编排——盲跑是
  基座，引导回路才是产出引擎。这与 crash-triager 深挖模式（1.6.2 已产品化）
  的关系：深挖是「有种子崩溃后的同族扩展」，战役缺的是「零崩溃时的破冰回路」。

## 5. 本次实验没覆盖的（记录在案）

- agent 行为层的端到端（模型在 R1 编目可见后是否真委派 fuzz-runner）——
  需要真实模型会话，属用户侧 GUI dogfood，本实验只覆盖环境/工具链/指纹件；
- env_bg 长跑 + R2 完成回注的实机会话验证（单测已覆盖注入点语义）；
- pwn-win（Windows）链路——1.6.4 的实机验收门与本实验独立。

## 6. 判定

**实验成立**（链路打通 + 两处配方坑实证修复 + 盲跑/引导对比数据到手）。
1.6.8 战役原语设计稿的第一输入：§4 的「破冰回路」需求 + 本报告的时间经济学。
