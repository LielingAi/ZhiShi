# auto 重做设计（auto run == auto loop，统一语义）

> 版本：2026-09-19 定稿（与 WREN 讨论收敛，多处拍板修订）。状态：**1.7.7 实现完成，dogfood 待实机**。
> 前置设计：auto-loop-design.md（1.4.1）、1.7.0-policy-design.md（1.7.0）——本稿取代两者。
> 结论先行：auto 是三输入四停点的最小循环。1.4.1 的 5 暂停点 + 1.7.0 的策略文件 + 快照/checkpoint/报告都是给"被削弱的 auto 路径"打的补丁；本稿先修根因（路径对齐，已落地），再删补丁。

## 1. 语义定稿（唯一形态）

> **AUTO 与 GUI 交互轨迹同构：未达成、未到时间，就一直继续。模型没有自我退出权。**

**输入三件**：

| 输入 | 语义 |
|---|---|
| 目标提示词 | 驱动循环的锚，一段自然语言 |
| 验收条件 1-N 条 | **OR 语义：任一条件满足即达成**（改掉现状"全部达成"） |
| 强制超时 | 轮次 / token / 时间三选一，唯一兜底 |

可选第四输入：**空转推进话术**（自然语言一段，缺省 = 内置通用话术，可自定义，可关闭——见循环语义）。

**循环：每轮结束自动发起下一轮，永不暂停、永不问人。**

- 空转 → **继续 + 可选推进话术**：harness 检测空转（连续 3 轮无新增有效研究记录且阶段未推进）时，把推进话术作为 user 消息注入 loop 线（**系统注入的启动配置，非人工 steering**）——不暂停、不问人，浪费仍由强制超时封顶。话术来源优先级：研究员自定义 > 内置通用话术 > 关闭（纯继续）。内置通用话术的内容（1.7.7 对比实验教训）：提醒区分「死路」与「墙」——下"不可行"结论前，先逐堵列出墙与可拆方案，别把当前障碍直接写成死路（实验：auto 的失败模式正是把墙写成死路）
- 需要澄清 → **自主决策继续走**：交互模式的"澄清" = 模型经 `request_decision` 弹面板请人选择（GUI 保留此机制不动）；auto 模式该工具**不注册**，模型没有问询通道——遇歧义自己选最可能路径，并把问题与假设记进档案（Q# 未决问题），人事后在轨迹/档案中看到。猜错由超时兜底
- 工具失败（命令错/工具缺/编译不过）→ **继续**，这是研究信号不是故障
- 模型宣称达成（declare 附证据引用）→ harness 逐条对照验收条件做证据存在性检查：
  - 任一条件命中（OR）→ `completed`
  - 未命中 → 回注「条件未满足」继续跑
- **模型没有自我退出权**：它说「不可行 / 卡死 / 完成不了」都只是轨迹内容，不是停点——未达条件、未到超时，就一直继续。与 GUI 交互轨迹同构：人不在场时，系统的「继续」是自动的
- **provider/基础设施故障（API 超时/过载/鉴权失败）→ 连续 5 次 → `exited`**，终态原因明确标注 provider-error——这是唯一的非人非超时停点，因为循环已无法运转，继续是纯浪费
- 强制超时到 → `stopped`（无 checkpoint、无报告——产出见 §4b）
- 研究员 Esc → `stopped`

**终态只有四个**：`completed`（达成）/ `stopped`（超时或 Esc）/ `exited`（provider 故障）/ `running`。没有 paused、没有 awaiting-verdict、没有 verdict 终审、没有 budget 续命、没有 checkpoint、没有自动报告。

## 2. 判定权归属（保留 1.4.1 的一条好原则）

- **达成判定权在 harness 的预检，陈述权在模型**：模型 declare 时给出"哪几条条件 + 每条的证据引用（E#N / 档案实体）"，harness 只做证据**存在性预检**（引用的研究记录/档案实体真实存在）。预检通过即 completed。
- **停点只有四个**：条件命中（harness 证据确认）、强制超时、人 Esc、API 连击死亡（N=5）。模型无任何自我退出通道——「不可行论证」是研究产物（进档案/轨迹），不是退出票；它只有对应到某条条件才算达成，否则超时封顶继续（2026-09-19 对比实验：auto 13 分钟兜底 declare 假完成、GUI 逐个拆掉其判死刑的障碍——早退即错误）
- 系统不判 pass/fail、不判"发现质量"——它只做条件命中检查；研究结论由人回看轨迹与档案形成。
- 空转检测保留，但角色改变：从"提请暂停"降为"触发推进话术注入"的纯信号；反复失败不做判定——工具错误是研究信号，API 故障按连击退出。

## 3. 删除清单（过度设计的部分）

1. **策略文件整体**：`on_decision/on_stall/on_failure/on_budget/on_declare` 五节 schema、`shared/auto-run-policy.ts`、`examples/auto-run/*.yaml`、`docs/auto-run-policy.md` 重写为「已删，见本稿」。五节中唯一存活的语义 = 空转推进话术，降级为**单个可选输入**（CLI `--stall-prompt "…"` / GUI 表单一个字段），不再有文件形态
2. **5 暂停点全删**：stall / repeated-failures / budget 提请 / decision 暂停 / verdict 终审（`requestDecision` 在 auto 线不再注册；boundary-ask 越界仍保留——越界是 D14 边界，不是 auto 暂停点）
3. **turnTimeoutMs 停语义**：现状超时 = 停 run（turns=1, stopped, provider-error）。改为**纯 liveness 守卫**：只断等待、不断 run（detach 后继续轮询）；缺省已拉大到 24h（Phase A 已落地），只在真挂死生效。它不是用户可见概念，不出现在 auto 语义里
4. **CLI/GUI 双模式**：`record.policy == null` 分支、GUI 原生交互路径、verdict/budget 命令——全部收敛为一个 runner，GUI 表单与 CLI 是同一 start() 的两个入口
5. **相关命令**：`zhishi auto-run verdict / budget` 删除；`list/stop/clear` 保留
6. **docs/auto-run-cli.md** 重写为三字段用法
7. **开局快照 / 超时 checkpoint / 自动报告导出**（2026-09-19 拍板砍掉）：旧设计遗留，非循环语义的一部分。结束后产出 = 轨迹 + 研究事件 + 档案（见 §4b），零报告文件

## 4. 保留清单

- 证据存在性预检（declare 对照条件查证据——「条件命中才停」的判据载体）
- Esc / `zhishi auto-run stop`
- 越界 ask（D14 边界纪律，auto 模式下不漂移）
- 同 envKey 互斥闸（1.7.0 已落地，保留）
- 僵尸愈合（sidecar 重启 running → stopped；awaiting-verdict 形态随删除消失）

## 4b. 产出与观察面（结束之后看什么，零新机制）

auto run 结束后没有报告文件——交付物全部来自既有机制，路径约定如下：

| 交付物 | 位置 | 查看方式 |
|---|---|---|
| **轨迹文件**（全程消息/工具调用，可回放） | `<数据目录>/loop-sessions/<loopSessionId>.jsonl` | `zhishi auto-run list` 输出 loopSessionId；GUI 历史面板开线回看；`/api/loop-session/messages` wire 回放 |
| **研究事件**（research_log 留痕） | memory.db `research_events` 表 | `zhishi research list`，E#N 编号 |
| **研究档案**（H/V/C/Q/R# 实体） | `<loop-sessions>/<loopSessionId>.archive.json` | `zhishi archive list` + GUI 档案看板 |
| **run 记录**（状态/轮数/预算/终态原因） | `<数据目录>/auto-runs/<runId>.json` | `zhishi auto-run list` 数据源 |
| **环境内产物** | 环境 `/workspace` | 研究员自行提取（D14 越界纪律不变） |

## 5. 前置对齐修复（根因，Phase A 已全部落地）

auto 路径今天比交互路径弱，这是"GUI 能成、auto 不成"的根因。已落地三处：

1. **auto-run 走 security 场景完整装配**（`chat-engine.ts`）：caps（能力清单/安全内核/native-code 段）与 `collectResearchMemory()`（研究记忆反哺）对 auto-run 与 security 同权注入；域判定（domain）连带恢复。只保留 AUTO_RUN 通道文案"每轮自动继续、研究员事后回看"这一句差异
2. **turnTimeoutMs 改 liveness 守卫**：缺省 24h（`auto-run.ts` / `config-types.ts` 两处同步）
3. **steering 保持关闭（拍板）**：auto 是自动形态——纠偏由「明确目标 + 验收条件」承载，条件即终局；运行中人的接口只有观察 + Esc。空转推进话术是启动时配置的系统注入（非人工 steering），与关闭语义不冲突

## 6. 代码改动面（Phase B）

| 文件 | 改动 |
|---|---|
| `loop/auto-run.ts` | 1996 行 → 估计 400 行内：runner = 循环 + declare 预检 + provider 连击退出；删除 policy 分支/暂停点/verdict/续命/checkpoint/报告调用 |
| `loop/chat-engine.ts` | auto 线不注册 request_decision |
| `loop/declare-completion.ts` | declare 语义改 OR：模型声明"哪几条 + 证据引用"，预检按条；未命中回注「条件未满足」 |
| `system-prompt.ts` | AUTO_RUN 通道文案微调（保留 headless 说明，删"暂停点/验收点介入"——Phase A 已改） |
| `shared/auto-run-policy.ts` | 删除 |
| `cli/zhishi.ts` | auto-run 命令组删 verdict/budget/--policy-file；start 参数即三字段 + --stall-prompt |
| `gui/` | AutoRunCard 表单收敛三字段（+可选空转话术）；删除 verdict 弹窗；运行卡 = 观察 + Esc |
| `sse.ts` | 事件族收缩（paused/verdict-requested/budget-warning 等删，需同步 crosscheck 对账） |
| docs / examples | 见 §3 |

## 7. 验证

1. 单测：OR 语义预检（任一通过即 completed / 全不过回注继续）、provider 连击 5 次 exited、tool 错误不退出、超时 → stopped（无 checkpoint 无报告）、Esc、互斥闸、僵尸愈合
2. dogfood：真实任务全流程 + 结束后按 §4b 走查交付物可见性
3. 回归：GUI 表单、CLI 命令、stateful 池全绿

## 8. 参数定案（1.7.7 立项时拍板）

- provider 连击退出阈值 **N = 5**
- 空转 nudge 触发阈值 **K = 3**；重复策略 = 每次检测注入一次并清计数，再空转再注入
- steering 关闭、campaign 独立不并入、开局快照/超时 checkpoint/自动报告已砍（2026-09-19）
