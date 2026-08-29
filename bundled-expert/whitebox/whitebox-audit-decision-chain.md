---
kind: sop
title: 白盒审计决策链——从入口到漏洞确认
applicability: 源码级漏洞挖掘（审计开源项目/目标代码，找注入/越权/逻辑漏洞），需要一条不乱跳的审计主线时。
criteria: 每环都有产出信号：输入面清单 → 扫描告警分级 → source→sink 可达性结论（含不可达的负结果留痕）→ CWE 编号 → PoC 或「不可达原因」。跳环 = 没走完。
tags: 白盒审计,opengrep,数据流,source-sink,ast-grep,joern,CWE
---

## 决策链（每环都要有「什么信号往下一步走」）

1. **选入口（先看地图，别上来就扫）**：入口文件/用户输入面（HTTP handler、CLI 参数、文件解析器）+ 技术栈判定（框架/ORM 决定漏洞类型分布）；大项目先划边界，一次审一个模块——审计最忌贪多。
2. **基线扫描拿免费线索**：`opengrep scan --config auto .`（离线 `--config <本地规则目录>`）。severity:error/warning 的注入类告警才追；style/lint 级直接丢。**告警是线索不是结论，每条人工确认**。
3. **告警分级**：必追=SQLi/命令注入/SSRF/路径穿越/反序列化；挑可达的追=越权/逻辑缺陷/信息泄露；放弃=风格/性能/未使用变量。
4. **数据流手工追（source→sink）**：rg 找 source 与 sink，逐条追可达性（过滤/编码/白名单）；文本匹配误报多时用 ast-grep 结构匹配（`sg run -p 'eval($CODE)' --lang python .`）；大项目上 Joern 污点一把出（`joern-parse` 建 CPG → `joern --script joern-taint.sc`）。**负结果（证明不可达）也留痕——这是死路清单**。
5. **CWE 映射**：确认问题挂 CWE（SQLi→CWE-89、路径穿越→CWE-22、SSRF→CWE-918），写进 research_log 的 bug_class。
6. **复核**：有条件写最小 PoC（读文件/回显/带外，越轻越好）；写不出的记「不可达原因」防重复审计。

## 常见坑

- 把 lint 当漏洞（severity 低 ≠ 漏洞）；误报不记（同一条误报反复追）；
- 依赖 CVE ≠ 可利用（pip-audit 命中要确认实际可达该函数/该版本路径）；
- CodeQL 成本高（数百 MB + 建库耗时）——只在 opengrep 给不出答案时用。

## 判据

- 小项目（≤~300 行）全量通读比模式匹配靠谱（实战：125 行全读 + 逐 sink 活体 PoC，5 确认 0 误报）。
- 降级：opengrep 不可用 → rg/grep 手工模式 + OWASP 清单逐类过；环境没有 → 请人开 code-audit 环境。
