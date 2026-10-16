# GUI 重做业务能力审查清单 —— v4 定稿前的不丢项底账

> 2026-10-15 · 目的：GUI 改版（v4 操作语法稿定调后）**一颗业务能力不许丢**。
> 逐组件/逐端点/逐菜单细审产物。每行：能力 → 现状实现（文件）→ 服务端契约 → v4 处置。
> 处置标注：【保】原样保留 ·【升】v4 语法升级重组 ·【新】v4 新做（有契约托底）·【补】服务端有 GUI 未接，借改版补上。

## A. 会话工作流（核心环）

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| A1 | 发送消息（环境锚定闸：无 env 禁发） | InputArea.tsx:66 / useGuiStore.ts:1389 | POST /chat/send |【保】 |
| A2 | steering（busy 时发送=纠偏，服务端裁决） | InputArea.tsx:152 / send.ts | busy→steering 队列 |【保】 |
| A3 | 停止 turn（Esc 乐观分隔线） | useEsc.ts / stopTurn :1423 | POST /chat/stop → stopPiChat |【保】 |
| A4 | 队列查看/取消 | QueuePanel.tsx | /chat/queue/status·cancel |【升】并入命令面板+侧栏 |
| A5 | rewind 回思路 | PickMessageModal + rewindTargets | POST /chat/rewind |【保】 |
| A6 | fork 分叉 | PickMessageModal + forkTargets | POST /sessions/fork |【保】 |
| A7 | reset 新线 | —（slash/store） | POST /chat/reset |【保】 |
| A8 | 模型切换 | model overlay + StatusBar 点击 | POST /chat/model |【保】 |
| A9 | @ 引用（env/file/snapshot chips + 补全） | InputArea.tsx:88 / mention.ts | workspace/files + refs 注入 |【升】对象补全面板 |
| A10 | 输入历史（per-env + 评分 + Ctrl+R） | input-history.ts :1507 | localStorage |【保】 |
| A11 | slash 命令 ×12 | slash-routes.ts:59 | 见 B-G 各端点 |【升】命令面板统一承载 |
| A12 | turn 折叠/展开（BadgeRow 徽标行） | TurnView.tsx:113 / blocks.ts:209 | reducer 状态 |【保】 |
| A13 | 工具卡（信号提取/Drawer 查看/复制/搜索） | ToolCard.tsx / Drawer.tsx / drawer-highlight.ts | tool-result-complete |【升】+对象检查器 |
| A14 | 思考块折叠 | TurnView.tsx:22 | thinking-* 事件 |【保】 |
| A15 | 空回复分级占位 | TurnView.tsx:179 | message-complete 零产出 |【保】 |
| A16 | 大值外溢 refs 协议（占位→取回重放） | useGuiStore.ts:888 / sse.ts:633 | GET /refs/:id |【保】红线 |
| A17 | 虚拟流 + 追底 + 顶/最新 + 档案锚跳转 | Stream.tsx:59-170 | — |【保】 |
| A18 | steering 徽标 | TurnView.tsx:149 | steering-added |【保】 |
| A19 | 会话自动标题 | session-title-changed :872 | session-title-service |【保】 |
| A20 | 中断轮次注记 ⟦系统注⟧ | chat-engine.ts:781 | 恢复装载 |【保】 |

## B. 线与历史

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| B1 | 按环境分线（envKey 指针 + replay） | useGuiStore.ts:984 | env-sessions.json 三段键 |【保】 |
| B2 | 切环境（busy 拒绝） | switchEnv / environment/select | select+switchEnvSession |【保】 |
| B3 | 历史页（搜索/分组/置顶/归档/重命名/删除） | HistoryPanel.tsx:163-412 | /sessions PATCH/DELETE |【升】线面板统一 |
| B4 | 载回续跑（resumeSession busy 闸） | HistoryPanel.tsx | /sessions/switch |【保】 |
| B5 | 只读历史视图（他线 ?sessionId=） | — | /chat/stream |【保】 |
| B6 | **线面板（线列表/活性/共享）** | **无（line/list 端点存在未接）** | line/list |【新】v4 一等对象 |
| B7 | **线分享/私有转共享** | **无 GUI 面** | line/share·unshare |【补】 |
| B8 | 多会话元数据（multi-session model） | model/multi-session.ts | /sessions |【保】 |

## C. 环境生命周期

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| C1 | 侧栏三组分组（运行/停止/本机） | EnvSidebar.tsx / sidebar.ts | environment/list·ps |【升】正门化 |
| C2 | 新建环境四步向导 | NewEnvModal.tsx:326 / env-wizard.ts | environment/add+setup |【保】 |
| C3 | VM 认领 adopt | AdoptModal.tsx:131 | environment/adopt |【保】 |
| C4 | 环境注册 | EnvRegisterModal.tsx:817 | environment/add |【保】 |
| C5 | 启动（镜像行点行即启 / up） | EnvSidebar.tsx:69-85 | environment/up |【保】 |
| C6 | 停止 down | EnvDownModal.tsx:1199 | environment/down |【保】 |
| C7 | 重建 rebuild | EnvRebuildModal.tsx:1301 | environment/rebuild |【保】 |
| C8 | 重置 reset | EnvResetModal.tsx:1346 | environment/reset |【保】 |
| C9 | 重命名 | EnvRenameModal.tsx:906 | environment/rename |【保】 |
| C10 | 删除（type-name 二次确认） | EnvRemoveModal.tsx:844 | environment/rm |【保】 |
| C11 | 详情/多配方绑定管理 | EnvDetailModal.tsx:1012 / bind-recipes | environment/bind-recipes |【保】 |
| C12 | 补齐 provision | EnvProvisionModal.tsx:1248 | environment/…provision |【保】 |
| C13 | 能力刷新 | — | environment/capability-refresh |【保】 |
| C14 | 准入闸（not-started 先重探 ps） | access-gate.ts | environment/ps |【保】 |
| C15 | discovered 发现（docker/vm/images） | refreshSidebar | environment/discover |【保】 |
| C16 | 占用可见 | 部分（侧栏徽标） | engines/claims |【升】徽章化 |
| C17 | attach 双模式（xterm WS / exec 一次性） | AttachView.tsx:310-351 | WS environment/term · exec |【保】 |
| C18 | snapshot / rollback | /snapshot /rollback | environment/snapshot·rollback |【保】 |
| C19 | extract / push（文件双向过界） | /extract /push（boundary ask 挂起） | environment/extract·push |【升】对象检查器出口 |
| C20 | workspace 文件列表（@数据源） | fetchWorkspaceFiles | /api/workspace/files |【保】 |

## D. 任务与战役

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| D1 | TasksPanel 四源行（campaign/bg/subagent/server） | TasksPanel.tsx:50-142 | campaign/list+task/list+SSE |【升】战役对象卡 |
| D2 | 任务 transcript 查看 | TasksPanel 选中行 | /api/loop-session/messages |【保】 |
| D3 | 战役终止/续命 | CampaignStopModal / campaign-resume | campaign/stop·resume |【升】卡上直达 |
| D4 | 战役信号史装配 | useGuiStore.ts:1933 campaignDetailLines | campaign/list |【升】信号流 |
| D5 | bg 任务登记 + 状态栏 ⛁ 段 | bgTasks / StatusBar | bg-started/finished |【保】 |
| D6 | subagent 登记 + 回报行 | subagents / BGR | subagent-* 事件族 |【保】 |
| D7 | server task（Rust 转发） | taskList/taskGet | /api/task/* |【保】 |
| D8 | **task 文档读写** | 读有写弱 | task/read-doc·write-doc |【补】看改版是否顺手带 |
| D9 | **崩溃件对象（双击→寄存器/回溯/动作）** | 无 | campaign 信号+research_events |【新】检查器 |

## E. auto-run

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| E1 | 启动表单（任务名/锁环境/目标/预算三选一/验收条件动态列表/空转话术） | AutoRunModals.tsx:30 | auto-run/start |【保】 |
| E2 | 观察卡（阶段/轮次/预算/最近结论/Esc 提示） | AutoRunCard.tsx:50 | SSE 事件族 |【升】徽章+回执 |
| E3 | 只读观察流（5s 轮询 wire） | AutoRunStream.tsx:44 | fetchSessionWire |【保】 |
| E4 | Esc 终止二次确认 | AutoRunModals stop | auto-run/stop |【保】 |
| E5 | run 记录列表 | api 有 autoRunList | auto-run/list·clear |【补】UI 弱，借命令面板带出 |

## F. 研究档案与情报

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| F1 | 链式看板（待答/线/孤儿区） | ResearchPanel.tsx:200-320 | archive:changed 整包 |【保】 |
| F2 | 分屏右/抽屉双形态（ratio 拖/swapped） | App.tsx:56-131 / archivePaneRatio | localStorage |【保】 |
| F3 | 行内纠正（R# 台账+署名） | correctArchiveEntity | archive/correct |【保】 |
| F4 | 证实 resolve（H#/Q#） | resolveArchiveEntity | archive/resolve |【保】 |
| F5 | 搁置 abandon | abandonArchiveEntity | archive/abandon |【保】 |
| F6 | 档案锚徽章 → 流内高亮 | TurnView.tsx:154 | setArchiveHighlight |【保】 |
| F7 | 锚跳流 jumpToArchiveAnchor | useGuiStore.ts | anchorMessageId |【保】 |
| F8 | 专家审定 promote（决策入专家库） | PromoteModal.tsx:687 | expert/add |【保】 |
| F9 | 情报库 intel（search/update/status；/intel 吃上下文） | SettingsPage intel 页签 + /intel | intel/* |【保】 |
| F10 | 研究列表 research/list | SettingsPage research 页签 | research/list |【保】 |
| F11 | 报告导出（sanitize 脱敏） | /export + exportResultToast | report/export |【保】 |

## G. 决策与越界

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| G1 | BoundaryModal（y/n + note + 5min 超时） | BoundaryModal.tsx:17-87 | boundary-ask/expired·respond |【保】唯一红 |
| G2 | 越界五类（host-write/local-cred/net-policy/destroy-env/system-config） | boundary-ask.ts:27 | 硬闸 deny 回注模型 |【保】 |
| G3 | DecisionModal（选项卡/a·b·数字键/专家依据/自定义应答/note） | DecisionModal.tsx:24-175 | decision-request/resolved·respond |【保】 |
| G4 | Esc 收起不作答（boundary/decision 保 pending） | esc-chain.ts:59-71 | — |【保】 |

## H. 设置与系统

| # | 能力 | 现状 | 契约 | v4 |
|---|---|---|---|---|
| H1 | 连接（本机/团队大脑 + host/token） | SettingsPage connection | port.ts / auth |【保】 |
| H2 | 模型供应商管理（add/remove/set-default/set-key/verify/自定义供应商） | SettingsPage model + CustomProviderModal + KeyConfigModal | model/* |【保】 |
| H3 | expert 管理（list/show/add/rm/drafts/review/import） | SettingsPage expert + ExpertImportModal | expert/* |【保】 |
| H4 | research/intel/appearance/about 页签 | SettingsPage | — |【保】 |
| H5 | 主题切换（深/浅，StatusBar 快捷） | theme.ts | body.light |【保】 |
| H6 | Toast 系统 | Toast.tsx | — |【升】回执沉底状态行 |
| H7 | 连接态机（discovering→…→failed+重试） | connection.ts / StateHint | /health |【保】 |
| H8 | BootModal（环境 boot 阶段条+ps 轮询，Esc 后台继续） | Modal.tsx:59 | environment/ps |【保】 |
| H9 | SSE 重连/last-value 快照/大 payload 外溢 | sse-client.ts:246 | sse.ts 全套 |【保】红线 |
| H10 | 远端模式（Tauri invoke 端口发现 / base URL+token） | port.ts | — |【保】 |

## I. 呈现与交互底座

| # | 能力 | 现状 | v4 |
|---|---|---|---|
| I1 | Esc 消歧优先级链 | esc-chain.ts |【保】架到状态行 Esc 语义 |
| I2 | Overlay 四态（slash/at/history/model） | Overlay.tsx:12 |【升】统一为命令面板+对象补全 |
| I3 | 状态栏（env 锚/模式角标/phase/队列/ctx/模型/⛁/主题/连接） | StatusBar.tsx:14 |【升】+动作回执 |
| I4 | 样式 token/BEM/z-index 体系 | styles.css:10-28 |【升】v4 token 重定义 |
| I5 | 空/载/错三态 | StateHint.tsx |【保】 |
| I6 | 虚拟列表渲染底座 | Stream.tsx |【保】 |

## 服务端有、GUI 未接（扩展位，非丢项）

line/share·unshare（B7 已列）、archive/op 模型直写、claim 认领、task 写面（D8）、persona/*、trust/*、memory/*、distill/*、config/*、auth/* 管理面——改版时按需顺手带，不列为必保。

## 计数

- 必保能力 **9 域 74 项**（A20+B8+C20+D9+E5+F11+G4+H10+I6，其中 D8/B7/E5 标【补】、B6/D9 标【新】）
- 红线协议（形状不可动）：SSE 事件名/负载形状、refs 外溢协议、Esc 链语义、boundary/decision 应答语义
