# 专家知识层 —— 迭代方案与技术方案

> 2026-08-21 定稿讨论记录。定位：1.2.x 后半程主线（或整个 1.x 主线）。
> 本方案经多轮对齐，关键边界（用户拍板）：
> - 专家知识 ≠ skills（方法是方法，知识是知识）≠ 蒸馏弧（LLM 自己的经验）≠ intel 库（结果原料）。
> - 专家知识是**最后的落脚点**：LLM 卡住、用户也不知道、蒸馏和 skills 都解决不了时，由专家知识做决策。
> - 存储 = 数据库单源（不存文件）；输入通道需专门设计（起草/审定分离）。
> - 不违背第一原则：思维在 LLM——harness 不做判断、不设认知闸门，只保证专家知识「可及、权威可辨」。

---

## 一、问题定义与知识权威层级

安全研究协作的根本困难：LLM 的「知道」与「不知道」在输出里无法区分；
人（研究员）可能也不懂该领域；此时谁做决策？

知识权威层级（从高到低）：

```
专家知识（审定过，决策级）—— 最后的落脚点
  ↑ 用户（研究员本人在行时直接给方向）
  ↑ skills（方法论：怎么做，不回答什么是真的）
  ↑ 蒸馏弧（LLM 自身经验，参考级，可能带错）
  ↑ LLM 权重知识（不可校验）
  ↑ intel 库（公共原料：结果数据，线索不是结论）
```

专家知识的形态：**思路**（这个场景往哪想）/ **技术知识**（怎么做、适用条件、
判据）/ **SOP**（标准作业流程）。共性：给内容不给方法，了结争论不参与讨论。

校准语义：「LLM 会不会」不靠模型自觉——找不到专家基准、环境复现不了，
就是不会；专家知识命中且可按其判据验证，就是会。幻觉 = 拿不出专家基准、
环境也复现不出来的「结论」。

---

## 二、迭代方案（三期）

### 1.2.1 —— 骨架期：库 + 通道 + 校验 + 首批内容

目标：层立起来，通道全通，内容有火种。
- expert.db（schema + FTS）+ `expert_search` 工具（无条件注册）
- 输入三通道：agent 起草→人审、编辑器往返、promote（蒸馏晋升）
- 格式契约单点校验 `validateEntry()`
- 内置首批：每域 2-3 条（选题来自 1.1.8/1.2.0 dogfood 亲历卡点）
- 时机教学：内核一句权威语义 + 各域 skill 补求助时机
- 验收：对照实验（卡点任务 ± 条目，量脱困率/幻觉率）

### 1.2.2 —— 飞轮期：内容循环 + 引用追踪

目标：知识开始自我积累，使用留下痕迹。
- promote 常态化：真实研究结束后，人把验证过的经验晋升进库（评审工作流打磨）
- 引用追踪：research_log 可关联 expert entry id（「本次决策依据 E#12」）；
  报告（1.2.0 出口）标注引用的专家知识——知识的使用变得可审计
- 冲突记录：LLM 判断与专家知识冲突时记录冲突点（谁对谁错都是学习材料）
- 时机教学调优：按实战调整「何时该查」（查太勤 = 懒，不查 = 白建）

### 1.2.3 —— 度量期：效果量化 + 内容扩充

目标：用数据回答「这层到底有没有用」。
- 指标基线与趋势：卡住后脱困率、幻觉率、专家知识引用率
- 内置库按真实卡点扩充（ dogfood 与用户反馈驱动）
- 视数据决定后续：条目版本管理 / 域间共享 / 社区内容

### 明确不做（任何一期）

在线同步/社区市场、自动晋升（promote 必须人审）、条目评分系统、
把专家知识混进 intel.db 或 memory.db。

---

## 三、技术方案

### 3.1 存储：`~/.zhishi/expert.db`（独立库）

better-sqlite3 + WAL + FTS5，照 intel.db 范式。物理独立 = 语义独立：
intel.db（原料）/ memory.db（LLM 经验）/ expert.db（专家权威）三库三权威级，永不混写。

```sql
expert_entries(
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,        -- 复用 RESEARCH_TASK_KINDS 闭集
  kind TEXT NOT NULL,          -- idea | technique | sop（闭集）
  title TEXT NOT NULL,
  applicability TEXT NOT NULL, -- 适用条件：什么时候该用它
  content TEXT NOT NULL,       -- markdown 正文（自由结构，知识不设模板枷）
  criteria TEXT NOT NULL,      -- 判据：怎么验证用对了（校准闭环的关键）
  provenance TEXT NOT NULL,    -- builtin | user | promoted（通道写入，不接受输入）
  reviewer TEXT,               -- user/promoted 必填——权威性的来源
  source_event_id INTEGER,     -- promoted 时关联 research_events.id
  tags TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,  -- 幂等/去重/变更检测
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
-- FTS5(title, applicability, content, tags)
-- drafts 表（agent 起草待审）：同构 + draft 状态标记
```

### 3.2 检索通道：`expert_search`（loop 工具，无条件注册）

- 注册点同 intel_search（chat-engine 工具注册处，不依赖环境锚定）。
- 入参：`query` + 可选 `domain` 过滤；FTS5 检索，≤5 条。
- 返回：title / kind / applicability / content（截断护栏同 intel_search 纪律）/
  criteria / provenance + reviewer（LLM 需要知道权威来源才能赋权）。
- **权威呈现**：返回包裹明确标记（「以下为专家审定知识，决策级依据」），
  与 intel_search 的「线索不是结论」标记形成对照——LLM 在上下文里
  一眼可辨权威级。
- 空库/未命中：明确返回「无专家知识」，不阻塞、不静默（未命中≠不存在，
  标注库边界）。

### 3.3 输入三通道（起草/审定分离，落库唯一）

**① agent 起草 → 人审（主通道）**
- 会话中研究员说「存为专家知识」→ agent 调 `expert_draft` 工具
  （Type.Object schema 结构化参数，schema 即格式限定）→ 进 drafts 表。
- 人审：`zhishi expert review`——逐条展示草稿 → 批准落库 / 进编辑器修改 /
  丢弃。agent 起草成本最低（它握着全部会话上下文），人审保证权威性来源。
- v1 不做 TUI 审批模态（CLI review 够用；TUI 模态留 1.2.2 评估）。

**② 编辑器往返（crontab -e 模式）**
- `zhishi expert new <标题>` / `zhishi expert edit <id>`：生成模板/导出
  现有条目为临时文件（frontmatter + markdown 正文）→ 开 $EDITOR →
  保存关闭 → 解析校验 → 落库。非法 → 列错误项重开编辑器，直到合法或放弃。
- 临时文件只是草稿介质，不留存不同步；DB 始终唯一事实源。

**③ promote（蒸馏晋升）**
- `zhishi expert promote <eventId>`：从 research_events/蒸馏经验预填
  （summary、轨迹引用带入），编辑器打开 → 人改完保存 = 审定动作。
- 晋升即跨界：provenance=promoted、reviewer 必填、source_event_id 关联——
  从「LLM 知识」变「专家知识」的分界线就是人审这个动作。

### 3.4 格式契约：单点校验

- `validateEntry()` 一处定义：闭集枚举（kind/domain）、必填非空
  （title/applicability/content/criteria）、provenance 通道写入、
  reviewer 条件必填。内置种子、CLI、TUI、agent 草稿全部汇入这一个函数。
- 编辑器文件格式 = frontmatter + markdown 正文（SKILL.md 同款惯例，
  解析器复用 `parseSkillFrontmatter` 同款机制）。

### 3.5 内置内容分发

- `bundled-expert/<domain>/<slug>.md`（frontmatter + 正文）随包分发——
  文件是**发行载体不是存储**；sidecar 启动按 content_hash 幂等导入/更新
  expert.db（provenance=builtin）。内置条目更新强制覆盖；user/promoted
  条目永不动。
- 首批选题：1.1.8 三域 dogfood 与 1.2.0 验收中亲历的卡点（每域 2-3 条，
  宁少勿精）。

### 3.6 时机教学（方法归 skills，harness 不设触发）

- 系统提示内核一句权威语义：「expert_search 返回专家审定知识（决策级）；
  与你判断冲突时以它为准，并在 research_log 记录冲突点」。
- 各域 skill 补求助时机：「先尽力；卡住、用户缺位、蒸馏无相关经验时查
  expert_search——查不到不阻塞，标注无先例继续」。
- D1 纪律：harness 不硬编码任何「必须查」的路径。

### 3.7 边界语义（写进三个工具的描述，防混层）

- intel_search：结果原料，线索不是结论。
- expert_search：专家审定，决策级依据。
- 蒸馏经验：自己的历史，参考级。
三者描述互相点名边界。

### 3.8 模块清单

- `src/server/expert/` — store.ts（schema/CRUD/校验/drafts）、seed.ts
  （内置导入）、search.ts（FTS 查询）；纯函数+薄 IO 惯例。
- `src/server/loop/` — expert-search 工具（chat-engine 注册）+ expert_draft 工具。
- `src/server/admin-api.ts` — expert/list/show/add/update/rm/review/promote/
  search 路由组。
- `src/cli/zhishi.ts` — `zhishi expert` 命令组（编辑器往返在其中）。
- `bundled-expert/` — 内置条目。
- 测试：store/校验/检索/三通道/promote 单测 + 对照验收活体脚本（tmp/）。

### 3.9 验收（1.2.1）

对照实验：选「裸模型会卡/会编」的真实卡点任务（dogfood 亲历），同任务
跑两遍（无条目基线 vs 预置对应条目）。断言：有条目时 卡住→查
expert_search→按条目走出且结果正确、criteria 被引用；基线行为记录对照。
指标：脱困率、幻觉率。CLI 三通道各走一遍（起草-审/编辑器/promote）。

### 3.10 风险

- **空库/劣库**（最大）：条目错了会被当权威执行——reviewer 必填、内置
  条目我们背书、引用可审计（1.2.2）。首批宁少勿精。
- **过早检索变懒**：skills 写明「先尽力，卡住再查」；1.2.2 用引用率数据纠偏。
- **权威僵化**：领域演进后旧条目过时——updated_at + review 通道支撑修订；
  条目淘汰机制视 1.2.3 数据再定。
