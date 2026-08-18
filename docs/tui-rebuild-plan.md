# TUI 重建技术方案（W3 落地蓝图）

> 版本：2026-08-16。需求 = `docs/design-spec.md`（定稿）；契约 = `docs/tui_tech_spec.md`。
> 本方案描述「建什么文件、改什么文件、每个文件的职责与接口」，**不含实现代码**，供审计与自行实现。
> 前置已完成：W0（决策 D27 + design-spec 修订，`9a07e0b`）、W1（服务端五项，未提交）、W2（自研 mini-renderer，`src/cli/tui/v2/` 五模块，未提交）。

> **落地校准（2026-08-17，W3 重做后）**：首版 W3 实现被否（视觉 CMD 感、交互断裂、链路造假），
> 已全盘重做。最终结构与 §2 的差异：
> - **新增 `chrome.ts`**——全部 pinned 视觉（状态栏/输入框/浮层面板/越界红框/菜单行）的唯一出处，
>   取代原 `status-line.ts` + `prompt.ts` + `completion.ts` + `modal.ts`（四文件已删）。
> - **新增 `commands.ts`**——slash 命令面唯一出处；只列真实端点（剔除六个打到不存在端点的死命令：
>   /chat/compact|export|fork|resume|to-background|env-change）。
> - `gate.ts` 改为纯数据+模型（渲染走 chrome），修正 `environment/select` 缺 workspace、
>   `snapshot`/`rollback` 缺 id 的链路错误；正门 Esc = 退出（D27），不再有伪 host。
> - `keymap.ts` 改为分词器（一 chunk 多键不再丢输入），支持 SGR 鼠标滚轮/kitty/修饰键正确解码。
> - `editor.ts` 修复 CJK 光标 cell 错位、多行粘贴尾段重复两个 bug。
> - `event-reducer.ts`：replay 按服务端消息 id 去重（重连不再整屏重复），user 块带 srvId（rewind 目标）。
> - `rewind.ts` 删除（候选构建内联 app）；越界模态组件保留在 chrome/app，触发面待服务端 ask 通道。

---

## 0. 输入对账（方案的一切以这些事实为地基）

### 0.1 W2 已交付（`src/cli/tui/v2/`，直接复用，不改其语义）

| 模块 | 提供的接口（描述） | W3 用法 |
|---|---|---|
| `style.ts` | `SemanticColor`（cyan/amber/purple/red/green/muted/faint/text）、`detectColorDepth()`（TrueColor→256→16）、`sgr(style, depth)` | 全部视觉映射的唯一出处 |
| `row-buffer.ts` | `RowBuffer.append(spans, {id?})` / `update(id, spans)` / `subscribe`；Span={text, style?} | 会话流、中断线 optimistic 先插后补 |
| `viewport.ts` | 追底/上滚冻结/回底恢复/「↓N 条新消息」计数（纯状态机） | 无模式回看 |
| `frame-scheduler.ts` | ~16ms 合帧；`flush()` 立即出帧 | 流式合帧；Esc optimistic 走 flush |
| `terminal-writer.ts` | `TerminalWriter`：`enter()/exit()`、`append/updateRow`、`scrollBy/scrollToTail/scrollToTop`、`setStatus(Span[][])`、`setInput(spans, cursorCol)`、`resize()`、`flush()`；导出 `wrapSpans/truncateSegments/overlayRight` | 唯一写屏通道；布局 = 会话流 + pinned 状态行 + pinned 输入行 |
| `ansi.ts`（既有） | 宽度数学 + ANSI 原语 | 不动 |

**W2 已知两个扩展点**（W3 需小改 v2，属预期）：① `terminal-writer` 输入区目前固定 1 行，layout 已参数化，需支持 `inputHeight>1`（多行输入）；② `statusHeight` 构造期固定，越界模态需要运行时改高——提为运行时 setter（`setChrome({statusHeight?, inputHeight?})`，改后走全量 reflow 既有路径）。

### 0.2 W1 已交付的服务端契约（未提交，消费即可）

- `chat:status {sessionState}`：turn 开始/结束/中断/重置时广播（状态行数据源）。
- steering：`/chat/send` busy → steering 队列注入；事件 `chat:steering-added {queueId, messageText}`；响应 `{steering:true}`。`/chat/queue` 显式排队保留 FIFO（`queue:added/cancelled`、`/chat/queue/status`）。
- subagent 事件族（`sse.ts:70-71,111-113` 已注册）：`chat:subagent-tool-use`、`chat:subagent-tool-result-start`、`chat:subagent-tool-result-complete`（+两个 delta 变体）。
- refs：`/chat/send {text, refs?: [{type:'file',path}|{type:'env',id}|{type:'snapshot',name}|{type:'taskmd'}]}`（`src/server/loop/refs.ts`）。
- admin：`environment/snapshot {id, name?}`、`environment/rollback {id, snapshot}`（`admin-api.ts:6036/6070`）。
- 既有不变：`/chat/send|stop|reset|stream|rewind`、`environment/*` admin、`/api/admin/term/open`、全部 chat 流式事件（附录 A of tech spec）。

### 0.3 旧 TUI 处置（W3 末尾执行）

- **删**：`agent.ts / screen.ts / input.ts / keyparser.ts / approval.ts / ask-question.ts / status-area.ts / status-collector.ts / agent-events.ts / env-selector.ts / chat-commands.ts` + 对应 12 个测试文件。
- **留**：`ansi.ts`（宽度地基）、`client.ts`（REST+SSE 客户端，注入 FetchLike 可测）。
- **入口切换点**：`src/cli/zhishi.ts:59`（`runAgentLoop` import）与 `:2816-2839`（裸 `agent` 命令 + `--env/--new-env` 旗标透传）。

---

## 1. 总体架构

新建全部位于 `src/cli/tui/v2/`，按「数据归约层 → 呈现层 → 交互层 → 编排层」四层组织，依赖单向：

```
sidecar SSE/REST
   │ (client.ts，既有)
   ▼
① 归约层 event-reducer.ts   SSE 帧 → 会话流行（Span[]）+ 状态区信号 + 模态信号
   ▼
② 呈现层 blocks/ + status-line.ts + prompt.ts
   行生产器（用户/助手/工具卡/思考/分隔线/回报行/错误条/模态框）
   ▼
③ 渲染 W2 row-buffer → viewport → frame-scheduler → terminal-writer
   ▲
④ 交互层 keymap.ts + editor.ts + completion.ts + history.ts + command-router.ts
   按键 → 编辑/补全/命令 → REST 调用
   ▲
⑤ 编排层 app.ts（主 loop：正门→会话绑定→SSE 泵→按键分派→模态/挂起管理）
```

测试纪律沿用 tech spec §8：①②④ 纯函数/注入式单测；③ VT 断言屏态；⑤ 虚拟 SSE 回放集成验证；**不用真 TTY、不依赖真模型**。

---

## 2. 新建文件清单（12 个）

### 2.1 `app.ts`（编排层，约 350 行）

主循环，替代旧 `agent.ts`。职责链：

1. TTY 检查（非 TTY 打印提示退出）→ 正门（`gate.ts`，§2.11）→ 会话绑定（`GET /sessions` + `POST /sessions/switch` 或 `POST /sessions {scenario:'security'}`——scenario 链是语境注入开关，不可丢）。
2. 建 `TerminalWriter`（enter alternate screen）→ 起 SSE 泵（`client.ts` 的 async generator，自动重连）→ 每帧：SSE 帧 → `event-reducer` → 产出三类输出（会话流行 append/updateRow、状态信号进 `status-line`、模态信号进 `modal`）。
3. 按键分派：经 `keymap.ts` 归一化后的语义动作执行（编辑动作给 `editor`、命令给 `command-router`、Esc/Ctrl+Z/滚轮给中断与回看控制）。
4. 模态管理：越界模态激活时按键只接 `y/n`（design §6.6）；`/attach` 挂起/恢复（§2.9）。
5. 轮询：`/chat/queue/status` + `environment/ps` + `task/list`（5s 空闲/15s running——sessionState 已有 `chat:status` 即时源，轮询只做兜底校正）。

公开面：`runApp(options: {env?: string; newEnv?: string; port: string})`（对应 zhishi.ts 的旗标透传）。

### 2.2 `event-reducer.ts`（归约层，约 300 行）

纯函数 `reduceSseEvent(event, state) → {rows?: RowPatch[], status?: StatusPatch, modal?: ModalSignal}`。逐事件映射（形状见 tech spec 附录 A）：

- `chat:message-chunk` → 追加到「当前助手块」的行尾（块不存在先开块，行首 `⏺`）。
- `chat:thinking-start/chunk` → 思考块（默认折叠：`⏵ thought · Ns`，灰；展开态由 blocks 管）。
- `chat:tool-use-start` → 开工具卡（`⚙ <name> · <参数一行摘要>`，purple）。
- `chat:tool-result-complete` → 关闭工具卡：经 `signal-extract` 提取关键信号改摘要行（`⚙ env_exec · ✔ SIGSEGV at 0x41414141 · 1.2s`）。
- `chat:message-complete` → 收尾当前块（usage 不进会话流，进状态区上下文%）。
- `chat:message-stopped` → 中断分隔线**确认**：`updateRow(div-id)`（optimistic 已在按键侧先插）。
- `chat:message-error` → `✗` 错误条（red）。
- `chat:message-replay` → **冷历史渲染**：按 message.role 重放为用户/助手/工具块（旧 TUI 全跳，新 TUI 渲染——resume 主线）。
- `queue:added/cancelled`、`chat:steering-added` → 状态区队列深度 + 一条淡色提示行。
- `chat:subagent-*` → 状态区中段静态段更新 + finish 时插「后台回报行」（结论摘要 ≤200 字 + 「要我切过去吗」尾钩）。
- `chat:status` → sessionState 直通 status-line。

### 2.3 `blocks/`（呈现层·会话流元素，约 400 行共 4 文件）

- `message-block.ts`：用户（`❯` amber）/助手（`⏺` 正文色）消息的行生产；Markdown 子集渲染：列表、行内 code、代码块（左侧 purple 竖条 span）——自研轻渲染，不引依赖。
- `tool-block.ts`：工具卡状态机（running → done/fail），折叠/展开两态；展开 = 参数 + 输出（长输出内部滚动：展开态复用 viewport 的子窗口，v1 可简化为「展开占会话流多行，随主视口滚」）。
- `signal-extract.ts`：**独立纯函数模块**（设计稿 §4 附加律的引擎）：正则表驱动，输入工具名+输出文本，输出摘要信号串。v1 规则表：`exit=N 非零`、`SIGSEGV/SIGABRT at 0x…`、`flag\{…\}`（→ green 成果色）、`CVE-\d{4}-\d+`、端口命中 `(\d+)\/tcp\s+open`、`password/flag/token 命中`（→ 不显示内容只显示命中）。每规则一条单测。
- `dividers.ts`：中断分隔线（optimistic 先插 `── ⏸ 已中断 HH:MM ──`，回包补「N 个工具结果已保留」）、后台回报行、错误条。

### 2.4 `status-line.ts`（状态一行，约 150 行）

`composeStatusLine(snapshot) → Span[]`：左段 `◐运行中/○空闲/⏸已中断` + `队列N` + `上下文N%`；中段 `⛁ <任务> · <产出计数>`（subagent 静态段，无动画）；右段 **此刻 Esc 含义**（`Esc 停/Esc 取消/Esc 回底`，由模态态/回看态/中断态推导，永不裁剪）。窄屏裁剪序：模型→队列→上下文%。快照字段来自 reducer 的 StatusPatch（数据契约同旧 StatusSnapshot 语义，新增 escHint/backgroundSeg 两字段）。

### 2.5 `prompt.ts`（提示符，约 60 行）

`<envName>@<kind> ❯`（cyan）+ 输入行内容。环境名/kind 来自正门选定（env admin 返回）；host 不存在（D27）。

### 2.6 `editor.ts`（交互层·多行编辑器，约 250 行）

纯状态机（参考旧 `LineEditor` 的 grapheme 索引法扩展）：多行缓冲（`Shift+Enter` 换行）、grapheme 光标、词跳（Ctrl+←/→）、Home/End、Ctrl-A/E/U/K/W、kill-ring 可选。渲染经 `writer.setInput(promptSpans + editSpans, cursorCol)`；行数变化 → `setChrome({inputHeight})` 触发 reflow。粘贴：bracketed-paste 序列识别（`\x1b[200~ … \x1b[201~`），整段插入不逐字触发补全。

### 2.7 `keymap.ts`（交互层·键位归一化，约 120 行）

字节流 → 语义动作枚举（复用旧 keyparser 的 CSI/SS3 解析覆盖面，重写为查表）：Esc（语义按 §2.4 的 escHint 分派：弹层取消 > 回看回底 > 中断）、Ctrl+Z（回思路）、Ctrl+O（折叠/展开当前块）、Ctrl+R（历史搜）、Ctrl+L（重绘）、Tab（补全确认）、PgUp/PgDn/滚轮（scrollBy）、Shift+Enter（换行）、Ctrl+C（清行/空行退出）。ESC 消歧：kitty keyboard protocol 探测成功则零延迟，否则 30ms 超时 fallback（tech spec §6.7）。

### 2.8 `completion.ts`（`/` `@` 补全，约 280 行）

- 触发：输入首字符 `/` 或 `@` → 临时面板（渲染为 pinned 临时区，statusHeight 临时 +N，选完即恢复）。
- `/` 源（静态表，design §6.4）：环境组（`/attach` `/rollback` `/snapshot` `/env`）、线程组（`/fork` `/rewind` `/resume` `/compact`）、任务组（`/bg` `/tasks`）、配置组（`/model` `/reset` `/export`）。
- `@` 源（动态，经 admin API）：环境内文件（env_exec `ls`/find 前缀过滤）、环境条目（environment/list）、后台任务（task/list）、快照（environment/snapshot 列表——若无 list 端点，v1 从 vmrun listSnapshots 经 admin 补一个只读端点或先只补全已知名）、产物（task.md 提及路径）。
- 模糊匹配：子序列打分（参考 fzf 简版），分组展示，↑↓ 选、Tab 补、Enter 定、Esc 取消。
- 选定效果：`@file` → 发消息时带 `refs:[{type:'file',path}]`；`@env/@snapshot` → refs 对应类型；`@task` → 元数据经 refs 或命令。

### 2.9 `history.ts` + `attach.ts` + `rewind.ts`（约 200 行）

- `history.ts`：历史落盘 `~/.zhishi/tui-history.jsonl`（每行 {ts, env, text}）；启动加载最近 1000 条；Ctrl+R 模糊搜（临时面板复用 completion 的呈现）。
- `attach.ts`（design §6.1 接管档）：`exitAlternateScreen` + 恢复 cooked mode → spawn 交互进程（vm/ssh 环境 = `ssh -i <keyPath> <user>@<address>`；docker = `docker exec -it <container> bash`）→ 子进程退出后 re-enter alternate screen + 全量 reflow。TUI 挂起期间 SSE 泵继续（事件入缓冲，回来追帧）。
- `rewind.ts`（Ctrl+Z 回思路）：弹历史消息列表（临时面板，倒序）→ 选定 → `POST /chat/rewind {messageId}` → 会话流截断重绘；若环境有快照锚点，提示可 `/rollback @snap`（解耦，不捆绑）。

### 2.10 `modal.tsx → modal.ts`（越界确认模态，约 120 行）

design §6.6：全产品唯一**红边框**块（box-drawing 字符绘框，span 级 red）。内容 = 越界类型（四类：写宿主/用本机凭据/改网络策略/销毁有成果环境）+ 对象清单（路径/凭据名/环境+成果列表）+ `[y] 批准 [n] 拒绝`。激活时替换输入区渲染（setInput 换成模态 spans + chrome 临时增高），按键只接 y/n（其余吞），状态行右段显示 `y 批准 · n 拒绝`。**没有「永远允许」**。v1 触发面 = `/extract`（环境→宿主文件提取，走新 refs/extract 流程；若 W1 未提供 extract 端点，v1 的模态做成通用组件 + 由 `/extract` 命令本地触发演示路径，服务端 ask 通道后续接）。

### 2.11 `gate.ts`（正门屏，约 300 行）

design §7.1：选/建两动词，四分组（运行中 / 已停止 / **本机已有（D28 自动发现）** / 新建从环境类型）。数据源与降级语义复用旧 env-selector（`environment/list`+`ps`+`recipes`+`engines`+`current`，任一路失败降级为空不卡屏），**新增并行 `environment/discover`**（D28：只读扫描宿主机 docker 容器全量含已退出 + VM 全量，结果只进「本机已有」分组、不写配置；已注册环境从发现列表去重剔除；discover 失败不影响其它分组）。交互：↑↓（跳过置灰、回绕）、Enter 选定、Esc 退（保守退出到 shell，不再提供 host 选项——D27）。选中「本机已有」项时按类型（`docker`/`vm`/`ssh`）自动 `environment/add` 再 `environment/select`，仅选定才落盘（D28 选中即注册）；选中已注册项：`environment/select` 落盘 → vm 环境 `environment/up`（进度上屏：revert+start 等待期 spinner）→ 进主界面。`--env/--new-env` 旗标直通跳过（zhishi.ts 透传）。

### 2.12 `bg-tasks.ts`（后台拍肩膀，约 120 行）

subagent 事件 → 任务登记表（id → {描述, 产出计数, 最近结论}）：状态行中段静态段（`⛁ fuzz · 3 崩溃`）+ finish 时结论插行（含「要我切过去吗」尾钩——y 确认后走 resume 切换：当前会话任务卡（task.md 由 agent 维护）+ 新会话绑定）。手动面：`/bg`（当前 turn 转后台：调 subagent 委派路径）、`/tasks`（临时面板看列表即散）。

---

## 3. 修改文件清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/cli/tui/v2/terminal-writer.ts` | 加 `setChrome({statusHeight?, inputHeight?})` 运行时 setter（触发全量 reflow）；输入区支持多行 | W2 预留的扩展点 |
| `src/cli/zhishi.ts` | `:59` import 改为 v2 `runApp`；`:2816-2839` 入口与 `--env/--new-env` 透传对齐新签名；agent 帮助文本更新（新键位与命令） | 唯一入口切换 |
| `src/cli/tui/client.ts` | 不动（v2 直接复用）；若 SSE 事件订阅需筛选，在 app 层处理不改 client | 保留 |
| `docs/tui_tech_spec.md` | 附录 A 补 W1 新事件（chat:steering-added/subagent-*/chat:status 已有产生点） | 文档同步 |
| `bundled-skills/zhishi-cli/SKILL.md` | TUI 段落更新为新键位/命令面（若涉及） | CLI surface 未变则不动版本号 |

---

## 4. 逐项对照 design-spec（落地形态备忘）

| 设计稿 | 落地点 |
|---|---|
| §1 深潜单线程 | 无多环境视图；状态行中段只放静态存在感 |
| §2 只有环境（D27） | gate.ts 无 host 选项；提示符锚点唯一事实 |
| §3 chrome 两行 | terminal-writer pinned 状态行+输入行；会话流全高 |
| §4 五律 | style.ts 语义色；红=越界/错误、绿=成果（signal-extract flag 命中触发绿）；单 spinner |
| §5 元素规格 | blocks/ 四文件 + dividers；折叠一切过程（工具卡/思考默认折叠） |
| §6.1 中断五档 | Esc optimistic 分隔线（append+flush）、steering 直发、Ctrl+Z rewind、/rollback、/attach |
| §6.2 Esc 语义提示 | status-line 右段（弹层>回看>中断推导） |
| §6.3 无模式回看 | viewport 冻结+徽章；输入永不锁 |
| §6.4 说/做/指 | editor+completion（`/` 动词 `@` 名词同补全同历史） |
| §6.5 键位总表 | keymap.ts 查表（含 Ctrl+Z 修订） |
| §6.6 越界模态 | modal.ts（唯一红边框，y/n 无惯性） |
| §7 生命周期 | gate.ts 正门、rewind/resume、收尾 /snapshot+extract |
| §8 拍肩膀 | bg-tasks.ts（静态段+结论插行+切线确认） |
| §9 契约 | 全部消费 W1 既有契约，零新增（refs/snapshot/rollback/subagent/steering 已落地） |

---

## 5. 落地顺序（每波可独立验证）

1. **v2 扩展点**（setChrome + 多行输入区）→ v2 测试更新全绿。
2. **骨架**：app.ts + client 复用 + status-line + prompt + 消息块——能进 TUI、发消息、看流式、Esc 中断（optimistic）。
3. **呈现完成**：tool-block + signal-extract + 思考块 + dividers + 折叠（Ctrl+O）。
4. **输入完成**：editor 多行 + completion（`/` `@`）+ history（Ctrl+R+落盘）+ steering 直发。
5. **中断与回看**：Ctrl+Z rewind + /rollback + /attach + 无模式回看 + 冷历史渲染。
6. **模态与后台**：modal + bg-tasks + /bg /tasks。
7. **正门**：gate.ts 三分组 + 进度上屏 + 旗标直通。
8. **切换清理**：zhishi.ts 入口切换、旧 12 文件+测试删除、文档同步。
9. **全量验证 + 活体全链路**（配额恢复后）：tech spec §8 的活体清单 + design-spec 全节走查。

## 6. 测试方案

- **纯函数**：event-reducer（逐事件→行补丁断言）、signal-extract（正则表逐条）、status-line（快照→spans）、editor/keymap/completion（状态机）、modal、bg-tasks。
- **VT 断言**：v2 既有 70 测 + 新增（多行输入区 reflow、chrome 运行时改高、模态红框渲染、冷历史批量 append 首帧、滚动徽章）。
- **集成**：虚拟 SSE 回放（录制 dogfood ret2win 的事件序列）驱动 app 层，断言最终屏态（选环境→流式→工具卡折叠摘要→中断线→状态行三段）。
- **活体（配额恢复后）**：真 k3 + pwn-vm——发消息→steering 纠偏→Ctrl+Z→/snapshot→/rollback→/attach→@文件→后台任务→/chat/reset→重连冷历史→越界模态。

## 7. 风险与边界

- **契约红线**：不动 SSE 事件名/形状（新事件必须注册 sse.ts 优先级表 + 三方对账测试）、REST envelope、env-selection.json 结构、ansi.ts 宽度数学。
- **最大工作量点**：event-reducer + blocks（呈现语义最密）；completion 的 `@` 动态源（依赖 env_exec 列文件，环境未锚定时降级）。
- **已知遗留（非本方案范围）**：越界 ask 服务端通道（W1 未含，modal v1 先走本地触发）、~~fork 未实现（pi 侧 501）~~（2026-08-17 已实现：`forkLoopSession` + TUI `/fork`，`c5c8f9b`）、stop 不杀已发出 ssh 进程（迟到结果可能串行——reducer 按 turn id 丢弃迟到帧）。
- **回滚策略**：旧 TUI 文件 W3 末尾才删；若 v2 重大回归，`git checkout` 恢复 zhishi.ts 入口一行即可回旧 TUI。
