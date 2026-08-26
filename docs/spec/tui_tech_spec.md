# TUI 技术规范（重做设计的技术底账）

> **⚠️ 已退役归档（2026-08-26，1.3.9 TUI 退役执行）：交互式 TUI（`src/cli/tui/`）已删除，交互面为 GUI（`src/gui/`）。本文档仅供历史归档，不再维护。**
>
> 版本：2026-08-16（基于 HEAD `3296df5` 的代码实测盘点，全部结论带 `文件:行号` 证据）。
> 2026-08-16 增补订正：①附录 A 补列工具结果/subagent 事件（已注册、TUI 未消费）；②§6.1 补 `chat:status` 基建事实；③§7 补死代码与边界确认的区分。定稿设计见 `design-spec.md`。
> 用途：TUI 交互/渲染层重做设计的**契约边界手册**——哪些是关键、哪些不动、改什么影响谁。
> 读者：重写 TUI 的工程师。配套决策：D13（CLI 一等、删 GUI）、D15（全屏 TUI、打磨标准=别人的 GUI）、D17（首步强制人选环境）。

---

## 1. 总览：TUI 是什么、边界在哪

- TUI = `src/cli/tui/`——2026-08-17 重做后为 `v2/` 自研 mini-renderer（style/row-buffer/viewport/frame-scheduler/terminal-writer + chrome/commands/keymap/editor/event-reducer/gate/app），**手写 ANSI、零渲染依赖**（无 ink/blessed/readline；Ink 类方案已否）。旧 12 源文件 + 12 测试已随 W3 重做删除（仅留 `ansi.ts`/`client.ts`，见 `tui-rebuild-plan.md` §0.3）。
- 唯一入口：`src/cli/zhishi.ts:59` import `runApp`（v2），裸 `zhishi agent` 进入（`zhishi.ts:2816-2839`）。
- **职责边界**：

| 层 | 职责 | 不做什么 |
|---|---|---|
| **TUI（本规范）** | 渲染、键盘、输入编辑、状态区、环境选择、slash 命令、SSE/REST 客户端 | 不碰模型、不碰会话状态机、不碰工具执行 |
| **sidecar（src/server）** | 会话编排（chat-engine）、SSE 广播、REST 端点、env/term/task admin API | 不感知终端 |
| **loop 引擎（src/server/loop）** | agent loop、工具（env_exec/env_bg/delegate_task/research_log）、边界规则、压缩 | 不感知渲染——经 sse-adapter 翻译成事件 |

- 硬约束：**TUI 与引擎的唯一通道 = sidecar ROOT 的 SSE + REST**。重做任何部分都不得新开通道（不直连 pi、不直连 db、不读 loop 内部文件）。

---

## 2. 代码地图（12 文件）

> （2026-08-17 更新：下表是重做前的旧 TUI 代码地图——W3 重做后 12 文件中仅 `ansi.ts`/`client.ts` 保留，其余已删除、由 `src/cli/tui/v2/` 取代，见 `tui-rebuild-plan.md` §0.3 与「落地校准」。§3 契约结论仍然有效。）

| 文件 | 行数 | 职责 | 重做时的处置 |
|---|---|---|---|
| `agent.ts` | 507 | 主 loop：TTY 检查→选环境→绑会话→SSE 泵+按键分派+轮询 | **可重写**（编排层，但无测试覆盖，重写需补） |
| `screen.ts` | 365 | 三区布局渲染（输出/状态/输入），alternate screen + DECSTBM | **可重写**（渲染机制本体） |
| `ansi.ts` | 187 | ANSI 原语 + **grapheme/CJK 宽度数学** | **不动**（见 §3.5） |
| `keyparser.ts` | 217 | stdin 字节→KeyEvent（CSI/SS3/修饰位/UTF-8） | 可重写（建议保留解析覆盖面） |
| `input.ts` | 281 | LineEditor（纯）+ raw-mode 读取器 | 可重写（输入能力是痛点，见 §6.5） |
| `agent-events.ts` | 267 | SSE→RenderAction 归约器（纯） | 可重写（但事件契约不动） |
| `client.ts` | 273 | sidecar HTTP + SSE async generator（自动重连） | 建议保留（契约层封装） |
| `status-collector.ts` | 264 | 状态快照采集（SSE 即时+三路轮询） | 可重写（snapshot 字段是契约） |
| `status-area.ts` | 166 | 快照→1–3 行状态文案（纯） | 可重写 |
| `chat-commands.ts` | 140 | slash 路由（queue/force/reset） | 可重写 |
| `env-selector.ts` | 576 | D17 首屏环境选择器 | 可重写（流程契约不动，见 §3.3） |
| `approval.ts` | 145 | 审批队列（**死代码，§7**） | **删除** |
| `ask-question.ts` | 264 | AskUserQuestion 队列（**死代码，§7**） | **删除** |

依赖方向单向无环；TUI 跨层 import 了 4 个服务端模块（`server/utils/sse-parser`、`server/environment/*`（选择器）、`shared/types/askUserQuestion`）——**改这些服务端文件的导出会破坏 TUI 编译**。

---

## 3. 不动的契约（改了就连带改服务端/其他消费方）

### 3.1 SSE 事件名 + data 形状（最高优先级）

服务端 sse-adapter 的设计约束就是「TUI/渲染器零改动」。TUI 实际 handle 的事件（产生点/形状详表见附录 A）：

- 流式：`chat:message-chunk`（裸串 delta）、`chat:thinking-start/chunk`、`chat:tool-use-start`、`chat:message-complete`、`chat:message-stopped`、`chat:message-error`
- 会话：`chat:init`（**仅连接时一次**，含 `{sessionState, agentDir, loopEngine}`）、`chat:message-replay`（重连重放）
- 队列：`queue:added {queueId, messageText, isInFlight}`、`queue:cancelled`
- **新增事件必须注册 `sse.ts:64-139` 优先级表**（fail-closed 为 critical + 告警）。

### 3.2 REST envelope 形状

- 基址 `http://127.0.0.1:${ZHISHI_PORT}`（ROOT，非 /api/admin；`zhishi.ts:2827`）。
- 非 2xx 的 JSON `{success:false,error}` **原样返回不抛**（`client.ts:213-220`）——TUI 与 sidecar 共用同一面，改语义双侧一起碎（desktop renderer 已随 GUI 删除）。
- 端点清单：`/chat/send|stop|reset|stream`、`/chat/queue/status`、`/sessions(|switch)`、`/api/admin/environment/*`、`/api/admin/term/open`、`/api/admin/task/list`。
- 服务端存在但 TUI 未消费（重做可利用）：REST `/chat/queue/cancel`、`/chat/queue/force`、`/chat/rewind`；SSE `chat:tool-result-complete/delta`（工具卡渲染命脉）、`chat:context-usage`（上下文%）、`chat:subagent-tool-use`/`subagent-tool-result-*`（后台任务回报）。**均已在 `sse.ts` 注册，消费零新契约。**

### 3.3 环境选择流程（D17 契约）

- 顺序：**选环境先于绑会话**（`agent.ts:161-170`）。
- `env-selection.json` 的结构（`selection.ts:9-27`）是 S1 能力清单注入的**读取契约**，改 shape 必须同步 `system-prompt-security`。
- 会话创建带 `scenario:'security'`（`agent.ts:133-139`）——它驱动安全五段语境注入，丢了 agent 就「变笨」。
- 数据源降级语义：任何一路 admin 失败降级为空，**首屏永不卡**（`env-selector.ts:484-491`）。

### 3.4 断连安全

`/chat/stream` 断连不中断 turn（`index.ts:3618-3620`）——重连安全，重放幂等由 reducer/collector 承担（`chat:message-replay` 整体跳过防重，`agent-events.ts:256`）。

### 3.5 grapheme/宽度数学（`ansi.ts:111-186`）

所有布局正确性的地基（CJK=2、组合符=0、grapheme cluster 计宽），虚拟终端测试锁死行为。**任何新渲染栈必须复用或等价实现这套宽度语义**，否则中文/emoji 全错位。

---

## 4. 影响面矩阵（改 X 影响 Y）

| 改动 | 影响面 | 连带动作 |
|---|---|---|
| SSE 事件名/形状 | TUI + sidecar（sse-adapter/chat-engine）+ `sse.ts` 优先级表 + 三方对账测试 | 必须四处处同步；单测 `sse-whitelist-crosscheck` 会红 |
| `/chat/*` envelope | TUI client + chat-engine | 双侧同步 |
| `StatusSnapshot` 字段 | status-area 渲染 + status-collector 采集 + 其单测（214/229 行） | 三处同步 |
| 服务端 `sse-parser`/`environment/*` 导出 | TUI 编译 | 改导出先查 TUI import |
| `env-selection.json` 结构 | S1 能力清单注入 | 同步 `selection.ts` 读写双侧 |
| `ansi.ts` 宽度数学 | 全部布局（screen/env-selector/未来任何渲染层） | 虚拟终端测试（430 行）锁死 |
| 删除 approval/ask-question | `agent.ts:58-64,200-317,462-488`、`agent-events.ts:39-52,195-254` 的模态分支 | 一并清，不影响服务端（端点已删） |

---

## 5. 可自由重写的范围

- **渲染机制**：`screen.ts` 的「挂起重绘」机制、三区布局、重绘策略（换 ink/自研帧调度都行）。
- **输入层**：`input.ts`/`keyparser.ts`（多行、粘贴、补全、历史落盘都是增量空间）。
- **呈现**：`status-area.ts` 文案/行数、`chat-commands.ts` 命令面（新增命令自由）。
- **编排**：`agent.ts` 主 loop（注意：507 行**零测试**，重写时先把按键分派/SSE 泵的行为测试补上）。
- **死代码删除**：`approval.ts`、`ask-question.ts` 全文 + `agent.ts`/`agent-events.ts` 的模态抢占分支（§7 证据链）。

## 6. 已知体验痛点（代码证据，重做的靶子）

> （2026-08-17 更新：以下为旧 TUI 的痛点盘点，W3 重做已针对性修复——无模式回看/viewport、多行 editor、合帧渲染、ESC 消歧、语义色、死模态删除等均已在 v2 落地；保留此节作为重做的靶子记录。第 1 条的 `chat:status` 数据源已由 W1 服务端广播补齐。）

按严重度排序，每条带证据：

1. **sessionState 恒停留连接时刻（已修）**：W1 起 chat-engine 在 turn 开始/结束/中断/重置时广播 `chat:status`（`sse.ts:94` 注册 critical + `CACHED_EVENTS`），状态行即时翻转；`/chat/queue` 本地排队 + `flushIfIdle` 与 5s/15s 轮询节奏仍只做兜底校正。
2. **无滚动回看**：5000 行历史仅用于 resize 重画（`screen.ts:68`），PgUp/PgDn 被吞（`input.ts:86`），重连/重进会话输出区空白（replay 全跳）。
3. **每次 writeOutput 三段全量重画输入区**（`screen.ts:134-171`），流式 ~40ms 一帧无合帧——高吞吐闪烁。
4. **全量重绘触发频繁**：状态区 1↔2↔3 行跳动、输入折行变化、resize 都走 `repaintAll` 清屏重 wrap（`screen.ts:223-265`）——整屏闪。
5. **输入能力弱**：单行（`\n`→空格）、无 bracketed paste、无 Tab 补全、历史仅内存（`agent.ts:178`）。
6. **零样式**：无 SGR 颜色/粗体——工具行/错误/审批全靠字符前缀（`⏺ ✗ ⚠ ■`）。
7. **ESC 30ms 消歧延迟**（`input.ts:248`）。
8. **死模态占按键优先级**（`agent.ts:460-490` 永不可达但挡在正常编辑前）。
9. **队列语义漂移**：TUI 按 `queue:started` 减量，pi 引擎只发 `queue:added/cancelled`——靠 5s 轮询兜底，深度显示秒级滞后。
10. **abort 尾巴干扰**：被中断 turn 的迟到 tool-result/error 会混进后续输出（M4c 已知遗留：abort 不杀已发出的 ssh 进程）。

## 7. 死代码清单（重做时顺手删）

- `approval.ts`（145 行）、`ask-question.ts`（264 行）全文。
- `agent.ts`：approvals/asks 队列、`decide`/`finishAsk`、按键模态抢占（`:58-64,200-317,462-488`）。
- `agent-events.ts`：approval/ask-question/ask-question-expired action（`:39-52,195-254`）。
- 证据链：服务端应答端点已删（`index.ts:9109-9111`）；`permission:request`/`ask-user-question:*` 无 broadcast 产生点；pi 引擎边界是规则零问人（`loop/boundary.ts`）。
- **注意区分**（2026-08-16 补）：删的是旧「危险命令逐条审批」模型——该模型已被 D14 否决（界内全自动零审批）。新设计的**越界确认**（写宿主/用本机凭据/改网络策略/销毁有成果环境，挂 pi `beforeToolCall`，对应 P1 交付物 T3 边界确认）是另一件事：通道范围极窄、低频，不是恢复上述死代码。
- 另三个无产生点事件：`chat:agent-error`、`queue:started`、`chat:task-started/notification`（reducer/collector 里的处理分支也是死的）。

## 8. 测试面与重做策略

- 现状：12 个测试文件全走 vitest `unit` project（<5s）。风格三层：纯函数断言（ansi/keyparser/input/agent-events/status-*）、虚拟终端字节流（screen，自带 VT 模拟器）、注入 fetch（client）。
- **缺口**：`agent.ts` 主 loop 零测试；`env-selector` 的交互渲染/编排未覆盖。
- 重做纪律：
  1. 契约层（§3）先跑既有测试当安全网——agent-events/status-*/client/env-selector 测试全绿才算契约没破。
  2. 新渲染栈必须用**虚拟终端断言最终屏态**（照 `screen.unit.test.ts` 的 VirtualScreen 模式），不接受「肉眼看没问题」。
  3. `agent.ts` 重写前先补行为测试（按键分派/SSE 泵/轮询调度），否则重做=裸奔。
  4. 活体回归清单（改完必过）：选环境→发消息→流式→工具块→Esc 中断→/chat/queue 排队→/chat/reset→重连回放。

## 9. 重做设计约束（从契约反推）

1. **不动 SSE/REST 契约**（§3.1/3.2）——新 TUI 按现有事件消费；需要新事件走 `sse.ts` 注册流程。
2. **先拍 sessionState 数据源**（§6.1）——chat-engine 已补 `chat:status` 广播（W1，turn 开始/结束/中断/重置时发），TUI 直接消费。
3. **渲染栈已定**：自研 mini-renderer（`src/cli/tui/v2/`，2026-08-16 拍板；Ink 类方案已否——无模式回看/折叠块/optimistic 插入是其弱区）。新渲染栈必须复用或等价实现 `ansi.ts` 的 grapheme/宽度语义（§3.5）。
4. **环境选择器是产品流程不是 UI 细节**（D17）——重做成什么样都行，但「首步强制人选、agent 不得自建、host 兜底」三条语义必须保留。
5. **死代码随重做删除**（§7），不要在重写里移植死模态。

---

## 附录 A：SSE 事件 ↔ 产生点 ↔ TUI 处理 全表

（数据源：`agent-events.ts` reducer、`status-collector.ts`、`sse-adapter.ts`、`chat-engine.ts`、`index.ts`）

| 事件 | data 形状 | 服务端产生点 | TUI 处理 |
|---|---|---|---|
| `chat:init` | `{sessionState, agentDir, hasInitialPrompt, loopEngine}` | `index.ts:3632`（连接时一次） | reducer:132 + collector:114 |
| `chat:status` | `{sessionState}` | chat-engine（W1：turn 开始/结束/中断/重置广播） | reducer:138 + collector:115 |
| `chat:message-chunk` | 裸串 delta | `sse-adapter.ts:101` | reducer:142 |
| `chat:thinking-start/chunk` | `{index}` / `{index, delta}` | `sse-adapter.ts:104-106` | reducer:151-156 |
| `chat:tool-use-start` | `{id, name, input, streamIndex}` | `sse-adapter.ts:109` | reducer:165 |
| `chat:tool-result-complete` | `{toolUseId, content}` | `sse-adapter.ts:117-119`（`sse.ts:109` 注册 critical） | **未消费**（工具卡渲染数据源） |
| `chat:tool-result-start/delta` | 流式工具结果 | 服务端流式工具路径（`sse.ts:108,69` 注册） | **未消费** |
| `chat:subagent-tool-use` / `chat:subagent-tool-result-start/complete` | 子 agent 工具流 | delegate_task 生命周期（`loop/subagent.ts`，W1；`sse.ts:111-113` 注册） | **未消费**（后台任务回报数据源） |
| `chat:message-complete` | `{model, tokens×4, tool_count, duration_ms}` | `sse-adapter.ts:123` | reducer:173 |
| `chat:message-stopped` | null | `chat-engine.ts:640,662` | reducer:177 → `■ 已中断` |
| `chat:message-error` | 裸串 | `sse-adapter.ts:125` 等 | reducer:182 → `✗` |
| `chat:agent-error` | `{message}` | **无产生点（死）** | reducer:188 |
| `chat:message-replay` | `{message, replayKind}` | `chat-engine.ts:376`、`index.ts:3640` | 整体跳过 :256 |
| `queue:added` | `{queueId, messageText, isInFlight}` | `chat-engine.ts:343,430,668` | reducer:213 + collector:132 |
| `queue:started` | `{queueId}` | **无产生点（死）** | reducer:222 + collector:141 |
| `queue:cancelled` | `{queueId}` | `chat-engine.ts:634,651,689` | reducer:222 + collector:141 |
| `chat:task-started/notification` | `{taskId, description}` / `{taskId}` | **无产生点（死）** | collector:150-167 |
| `chat:system-init` | `{info, sessionId, model, tools}` | `chat-engine.ts:399` | reducer default 忽略 |
| `chat:context-usage` | 归一化 usage | `chat-engine.ts:536` | reducer default 忽略 |
| `permission:request` | — | **已删除** | reducer:195（死） |
| `ask-user-question:request/expired` | — | **已删除** | reducer:231/247（死） |
