# 原生 code_query 环境工具设计稿 —— 1.9.10（v2 · joern/CPG 语义查询）

> 状态：设计稿 v2（2026-10-15）。**实现完成且 E2E 实校通过（2026-10-16）**：
> §4 实验 1 真链路三问重放全绿——Q1/Q2 净荷 9.5KB、Q3 2.4KB（≤10KB 判据），
> 时延 8~9s（≤60s），答案人工核对 ✓；坏查询回注 joern 编译错原文、
> ensure_index 幂等 no-op。joern 4.0.656 实校钉正六处（E2E 才暴露、单测
> 抓不到）：① `-s` 废弃静默掉 REPL 空退 0 → `--script`；② `importCpg` 返回
> Option 需 `.get`；③ 节点取位走 `n.location`（无 .path/.line/.method），
> lineNumber 为 Option；④ 脚本 classpath 无 json4s → 手工拼 JSONL；
> ⑤ `importCpg` 会把 CPG 拷进 cwd `./workspace/`（8.5MB×2）→ 查询 cwd 改落
> .zhishi-cpg 内，防指纹漂移/重建风暴；⑥ 指纹 awk 的 `\$` 转义在 mawk 语法错
> → base64 包装只需一次 bash 解析，单引号内 $ 原样。另：`execInEnvironment`
> 的 ok 只代表通道成功，code_query 侧把 exitCode 折进 ok 才分得清
> "编译错"与"0 命中"。
> v1 → v2 修订（WREN 拍）：v1 的 ctags+FTS5 关键词索引被否——**挖掘对象都是
> 超大项目（内核/浏览器/固件级），有价值的查询是语义/数据流级**（"memcpy
> 且 len 来自报文字段"），关键词检索在百万行规模上被命中淹没。v2  pivot
> 到 **joern CPG 语义查询**：joern 已随 code-audit 配方分发（CPG + CPGQL
> 是数据流问题的正主），本稿只做"工具化 + 生命周期 + 成本控制"。
> 立项依据：xerj spike（tmp/xerj-spike）证"段落级检索 ≫ 文件级阅读"
> （7.7×）——v2 保留此收益形态（截断段落返回），检索内核换成 CPG。
> 前置：D10/D11（环境原生）、D14、env_bg（CPG 构建走后台任务）；
> code-audit 配方已含 joern（joern-taint.sc 先例）。
> 纪律：评审通过前不写实现代码。

## 0. 一句话

**code_query = 环境内的 CPG 语义查询原生工具**：研究环境内按需构建代码属性
图（joern），模型用 CPGQL 问数据流/调用结构问题，拿回 **file:line + 截断
上下文段落**——超大项目审计的语义层，不再靠 grep 撞大运。

## 1. 为什么 joern 而不是关键词索引（v1 被否的根因）

| | v1 ctags+FTS5（否） | v2 joern/CPG（本稿） |
|---|---|---|
| 查询形态 | 关键词 + 符号名 | **CPGQL：数据流/调用图/控制流**——"参数来自报文字段"一语句命中 |
| 超大项目表现 | 通用词命中淹没 | CPG 是图，查询按结构剪枝，规模不稀释精度 |
| 配方现状 | 需新增 ctags | **joern 已在 code-audit 配方**（工具化即可） |
| 成本 | 建树 16s 级 | 建树重（见 §5 风险）——用 env_bg + stale 语义兜底 |
| 模型负担 | 低 | CPGQL 学习成本——SKILL.md 教学 + 例句库承担 |

关键词导航（"X 在哪""给我 Y 函数"）仍有价值，但作为 joern 之外的廉价补充
**后置**（不单独立项）。

## 2. 设计本体

### 2.1 工具面

```
code_query({
  query: string,        // CPGQL 表达式（SKILL.md 教模型写）
  target?: string,      // 目标树根（缺省 = env 工作目录）
  action?: 'query' | 'ensure_index' | 'status',
                         // 缺省 query：无 CPG 自动转 ensure_index
  timeout_sec?: number  // 缺省 60，硬上限 180
}) → {
  results: [{ path, line_start, line_end, text (≤1200 字符截断), score? }],
  cpg: { state: 'ready' | 'building' | 'stale' | 'missing' | 'failed',
         built_at?, files?, error? }
}
```

- 注册：buildTurnStack 挂载（chat-engine.ts 工具数组 + 两处 toolNames），
  boundary 白名单自动覆盖；未锚定环境不注册（同 env_exec）。
- joern 缺失 → 明确报错（code-audit/pentest 配方自带；工具自检兜底）。

### 2.2 CPG 生命周期（随环境生灭，D10）

- 存储：env 内 `<目标根>/.zhishi-cpg/`（joern workspace + 构建元数据）。
- 构建：`ensure_index` 走 **env_bg**（joern-parse/joern –import 大树分钟到
  十分钟级 → 后台任务，poll 语义复用既有 bg 机制）；构建期间 query 返回
  `{cpg:{state:'building'}}`，模型可见进度。
- 失效：目标根文件 mtime 集变化 → `stale`，查询仍服务旧图但标注；
  `rebuild` 走 ensure_index。
- 销毁：环境 reset/销毁即消失（一次性现场语义）。

### 2.3 成本控制（纪律内建）

- 查询超时 60s 默认 / 180s 硬顶（joern 端 + 工具端双闸）。
- 返回 top ≤ 8 条、每条 ≤1200 字符、总量硬顶 ~10KB；截断标注。
- 大目标（>50 万行）首次构建在 SKILL.md 明示预期时长，模型先 ensure 后
   poll，不空等。

### 2.4 SKILL.md 教学面（v2 新增关键件）

- CPGQL 速查：数据流（`reachableBy`/`flows`）、调用点（`call("memcpy")`）、
  参数溯源（`.argument(2).reachableBy(...)`）三族例句——照抄可跑的模板；
- 与 SAST 工具分工：joern 答"结构/数据流"，opengrep 答"模式"，fuzz 答
  "运行时"——不重叠。

## 3. 反例与砍单

- **不做自然语言→CPGQL 翻译层**（不在 harness 里再塞一个 LLM 循环；
  模型直接写 CPGQL + 例句库）。
- **不做跨语言统一索引**（joern 逐语言前端，v1 覆盖 C/C++/Java/JS/Python
  ——安全研究主战场）。
- **不做宿主侧 CPG**（界内原则）。
- **不做 GUI 面板**（结果走工具文本，气泡折叠呈现）。
- **关键词导航索引（v1 全文）后置**——等 joern 跑顺后再评估是否补廉价层。

## 4. 验收实验（先于实现锁定判据）

1. **语义查询重放**：usrsctp 真树建 CPG，三问全 CPGQL 化——
   Q1 m_getptr 全部调用点及其 len 校验存在性（数据流版，比 v1 spike 更
   深）；Q2 strmout 释放路径（调用图）；Q3 cookie_new→strmout 使用链。
   断言：三问答案正确性人工核对 ✓，净荷各 ≤10KB，查询时延 ≤60s。
2. **真链路端到端**：code-audit 配方环境起真树 → auto-run 打"审计 X 调用
   点参数来源"→ 轨迹含 code_query CPGQL 调用 + 截断返回 + 题线完成。
3. **回归**：unit 快池（CPGQL 清洗/截断/状态机纯函数，先红后绿）；
  typecheck；smoke 不受影响。

## 5. 风险（诚实面）

- **超大项目首次建树重**：内核级 CPG 构建数十分钟级 + 大内存（joern
  JVM）——env_bg + stale + SKILL 预期管理兜底；不接受就降目标粒度。
- **CPGQL 写错率高**：模型初期查询语法错误会烧 turn——SKILL 例句库 +
  工具端把 joern 报错原样回注（让模型自纠，不吞错）。
- **joern 版本/语言前端差异**：钉版本（配方级），语言覆盖表写进 SKILL。

## 6. 代码改动面

| 文件 | 改动 |
|---|---|
| 新 `src/server/loop/code-query.ts` | 工具构造（CPG 状态机 + joern 调用 + 截断） |
| `src/server/loop/chat-engine.ts` | buildTurnStack 注册 + 两处 toolNames |
| `bundled-environments/code-audit/SKILL.md`（或新增技能件） | CPGQL 例句库 + 分工说明 |
| 新 `src/server/loop/code-query.unit.test.ts` | 快池：状态机/截断/清洗（先红后绿） |

v1 的 ctags/FTS5 计划整体作废，不残留半成品。
