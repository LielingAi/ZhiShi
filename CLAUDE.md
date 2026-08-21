# ZhiShi — CLI 智能体



安全研究员 harness（环境融合 / 原生工具 / 原生代码），形态为 `zhishi` CLI + agent 全屏 TUI——**无窗口 / 无 GUI**（renderer 与全部前端已删除，见文末「安全研究员版转型」节）。核心 loop 自研（`src/server/loop/`，pi 底座；Claude Agent SDK 已随 D25 废弃删除）。开源（AGPL-3.0），Conventional Commits，不提交敏感信息。



## 技术栈



| 层级 | 技术 |

|------|------|

| 桌面宿主 | Tauri v2 (Rust)——无窗口：不创建任何窗口；保留 sidecar Owner、Panel API（仅 term）、Management API、CronTaskManager、托盘（仅 exit）、updater、统一日志。W6 减法已删：invoke_handler 全部 IPC 命令、SearchEngine（tantivy）、browser.rs、sse_proxy、global_shortcut、attachment_protocol、webview2_check、macos 窗框 hacks、workspace_files 命令层（path_safety 保留） |

| 后端 | Node.js v24 + 自研 loop（`src/server/loop/`，pi 底座钉版；多实例 Sidecar） |

| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |

| 运行时 | 单一 Node.js v24（Sidecar / MCP Server / CLI），内置于应用包 |



## 项目布局



- `src/server/` — Node.js 后端 Sidecar（esbuild 打包成 `server-dist.js`）。入口 `index.ts` 只做启动/路由分发（1.1.7 绞杀拆分后 7.7k 行）；崩溃日志 `crash-log.ts`、skills 配置 `skills-config.ts`、cron 路由 `cron/`、sessions/mcp 路由 `routes/`、admin-api.ts admin handler 包、`report/` 报告导出（1.2.0：骨架组装 + 证据回收 + LLM 填肉 + 落盘，设计见 `docs/1.2.0-design.md`）

- `src/server/appcraft/` — AppCraft 桌面自动化（terminator-client / replay-engine / recorder，见 PRD 0.2.36）

- `src/server/intel/` — 情报检索（1.1.2）：`intel.db`（NVD CVE + exploit-db 索引，FTS5）+ `zhishi intel update/status` + loop 工具 `intel_search`（宿主侧认知供给，与 research_log 同层）

- `src/cli/` — `zhishi` CLI（同步到 `~/.zhishi/bin/`），产品能力的统一入口

- `src/shared/` — 共享类型（server / cli 等消费）

- `src-tauri/` — Tauri Rust 层（无窗口；`tauri.conf.json` 的 frontendDist 指向 `src-tauri/placeholder/` 极简占位页）

- `bundled-skills/` — 13 个内置技能：agent-browser / ai-security / app-automation / binary-exploit / download-anything / native-code-loop / pentest / range-ops / task-alignment / task-implement / vuln-triage / whitebox-audit / zhishi-cli

- `bundled-environments/` — 环境类型（P1 E4 起）：ai-security / code-audit / dev / fuzz / fuzz-vm / pentest / pwn / pwn-vm / rev（docker / VM）。新增环境类型 = 建目录 + bump `ENVIRONMENT_RECIPES_VERSION`（src-tauri/src/commands.rs）

- `bundled-agents/` — 内置 subagent 定义（P1 A1 起）：fuzz-runner / crash-triager / vuln-hunter / hypothesis-tester / critic

- `bundled-domains/` — 研究域内容件（binary / pentest / whitebox / ai-security，各域 `domain.json` 声明）

- `docs/` — 设计文档（design-spec / tui_tech_spec / tui-rebuild-plan / env-bg-design / security_researcher_* / windows-release-build；导航见「文档体系」节。旧 `specs/` 已随 ac574f9 删除）



---



## 文档体系（必读）



本项目文档分两层。**每次会话只自动加载本 CLAUDE.md**，其它按需读取。



| 层 | 文档 | 加载方式 |

|----|------|---------|

| L1 | 本 CLAUDE.md | 每次自动加载，红线 + 元认知 + 文档导航 |

| L2 | `docs/design-spec.md` | **不自动加载**。任务匹配下方触发条件时 MUST 主动 Read |

| L3 | `docs/*.md`（按模块，见下） | 改特定模块时 MUST 主动 Read 对应文档 |



> **存档 caveat**：旧 `specs/` 设计文档目录（ARCHITECTURE.md / tech_docs/ / guides/）已随 ac574f9 整体删除——其中对 renderer GUI / IM / 需求单 / thought / 技能市场等已删模块的描述不再保留。现存 `docs/` 已随安全研究员版转型重写，与本文件冲突时以本文件和代码为准。



### MUST 主动 Read `docs/design-spec.md` 的触发条件



- 任何"设计 / 评估 / 规划 / 重构"层面的请求

- 修改 Sidecar 生命周期、Session 切换、Owner 模型、Pre-warm

- 跨模块 / 跨进程 / 新通信模式的功能

- 涉及 SSE / HTTP 代理 / 引擎交互的改动

- 新增 MCP server

- 你不确定某个功能"应该走哪条已有路径"



### 按模块必读的 docs/ 文档



| 改动范围 | 必读 |

|---------|------|

| TUI 渲染 / 事件归约 / 正门 / 命令 | `docs/tui_tech_spec.md`（技术规范）+ `docs/tui-rebuild-plan.md`（重建蓝图） |

| 环境内长驻进程通道 / env_bg | `docs/env-bg-design.md` |

| 产品定位 / 决策历史（D1–D31） | `docs/security_researcher_agent_design.md` + `docs/security_researcher_product_plan.md` |

| 引擎 / loop / 环境 / 记忆的技术映射 | `docs/security_researcher_agent_tech_plan.md` |

| Windows 发行构建 / NSIS / 资源打包 | `docs/windows-release-build.md` |



---



## 第零原则：极致体验 × 正确架构（最高判据，覆盖其余所有原则）



- **目标**：UX 与产品性能做到极致。

- **非约束**：token / 算力 / 耗时 / diff 大小——视为无限。**禁止**为"省事 / 最小改动 / 最快交付 / 最低风险"牺牲正确性。

- **唯一约束**：架构正确性 + 零技术债 + 零多余复杂度（correct by construction，新概念趋零）。

- **选型**：最大化 `UX杠杆 × 架构正确性`，约束 `Δcomplexity ≤ 0`；**不**按"最小安全交付"排序。effort / risk 用"先度量 + 多视角 review"管控，不用"少做"规避。

- **北极星——移除错位，而非叠加补丁**：性能 / 复杂度问题多是 work 放错了 owner / scope。正确修复 = 把 work 归置回正确的 owner（代码通常*变少*）。**在根因上叠一层 indirection（cache / guard / flag / scheduler / retry / wrapper）去绕过 = band-aid = 拒绝。**



## 第一原则：架构延续性



> 第零原则的推论：复用既有抽象 = 不引入多余复杂度。



**每个功能都在已有架构上生长，不另起炉灶。**



项目已有成熟的分层、通信、安全规范。新功能 MUST 复用现有模块和模式（`local_http`、`process_cmd`、`broadcast()`、`awaitSessionTermination()` 等），禁止为单点需求发明新的技术方案。



开发前 MUST 做的三件事：



1. **判断触发条件** — 对照上方"主动 Read"清单，决定要读哪些文档

2. **搜索现有实现** — `grep` / `find` 类似功能，复用而非重建

3. **读 SDK 源码** — 对接外部 SDK / 插件时 MUST 读源码确认接口（函数签名、config schema、返回值），再写适配层



如果需求**确实**需要架构变更（新通信模式、新状态管理、新进程类型），MUST 先与用户讨论方案，不得自行引入。



## Loop 引擎规范（D25/D26：自研 loop,Claude Agent SDK 已废弃）



项目核心 AI 运行时 = **自研 loop**（`src/server/loop/`，底座 pi——`@earendil-works/pi-ai` + `pi-agent-core`，版本钉死）。**Claude Agent SDK 已随 M4c 整体删除**（D25，2026-08-16）：`@anthropic-ai/claude-agent-sdk` 依赖、openai-bridge、permission:request 交互体系、buildClaudeSessionEnv 均已不存在。



关键约束：



- **pi 版本钉死 + 升级前回归**：pi 是 0.x 高频迭代项目（0.74→0.84 有 breaking 前科），升级前 MUST 跑 `npm run smoke`（一键入口，`scripts/smoke.mjs` 顺序跑 m1→m2→m3→m4a-client→m4b，先打印当前 pi 版本，真端点 + 真 VM；单个失败不中断，任一失败 → 编排器 exit 1，即升级阻断语义，exit 1 不得升级；m4a-sdk-observe 已除名——SDK 引擎随 D25 删除）。手动兜底（单脚本重跑 / 无编排器时）：`node --import tsx/esm tmp/m1-smoke.mjs`（同款 m2/m3），m4 系列见各自文件头注释（需先起 sidecar :3199）。禁止凭假设写 pi 交互代码——查 `@earendil-works/pi-agent-core` 的 .d.ts（注释密度高，是权威契约）。

- **工具执行体挂环境层**：`env_exec`（一次性执行）与 `env_bg`（后台长驻 start/poll/log/kill/list）经 SSH 在研究环境（Docker / VM / SSH 靶机）内执行，不在宿主跑（D25 的核心动机）；`delegate_task`（子任务，深度限 1）与 `research_log`（研究留痕，写 research_events）为 harness 原生工具。宿主执行类工具**结构性不存在**——这就是边界（D14），界内全自动、零审批。
- **env_bg Phase 3 稳定性闭环**（`docs/env-bg-design.md §8`）：登记表落盘 `<数据目录>/bg-procs/<工作区哈希>.json`（`loop/bg-registry.ts`，原子写失败不致命，启动恢复不重播 started）；poll 带存活探测（`kill -0` + .pid 一致性校验，探测通道失败保守报 running+probeFailed 不误杀）；**turn 结束（含 Esc 中断）与会话 reset 回收杀掉所有仍在跑的 bg 进程——暂定决策**，理由与「保留续跑+认领」替代方向见 `loop/bg-reap.ts` 模块头注释。

- **边界规则**（`loop/boundary.ts` 入向 deny / `loop/output-guard.ts` 出向净化）：规则是数据，allow / deny+reason 回注模型，零问人交互。新规则加进规则数组，不发明交互。

- **引擎开关**：`ZHISHI_LOOP_ENGINE` > config `loopEngine` > 缺省 `pi`；显式 `sdk` 一次性告警并回落 pi（死路径不保留）。



---



## 核心架构骨架（细节见 ARCHITECTURE.md）



理解以下抽象是改任何功能的前置认知。每条只列名字 + 关键约束。



### Sidecar Owner 模型

Sidecar 进程 = Node sidecar（自研 loop 引擎驱动）；Session : Sidecar = 1 : 1；多种 Owner（CronTask / BackgroundCompletion / Agent；`Tab` variant 为 GUI 时代 legacy，代码中惰性保留）共享 Sidecar，全部释放才停止。详见 ARCHITECTURE「核心抽象 / 资源管理」。



### Rust 代理层

sidecar 的 HTTP 访问经 Rust 代理（`local_http` 模块，reqwest）。localhost 通信 MUST 绕开系统代理（见红线表 `local_http` 条）。详见 ARCHITECTURE「通信模式」。（`sse_proxy` 已随 W6 减法删除——唯一消费方是 renderer。）



### 持久 Session

`messageGenerator()` 使用 `while(true)` 永远 yield，会话全程存活（引擎在 sidecar 进程内跑，已无 SDK subprocess）。

- 所有中止 MUST 用 `abortPersistentSession()`，**禁止**直接设置 `shouldAbortSession = true`（generator 会永久阻塞）

- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI "失忆"

- 两种重启不要混淆：直接 abort（立即 + interrupt）vs `scheduleDeferredRestart('mcp' | 'agents')`（防抖 + 下次 pre-warm 柔性重启）



详见 ARCHITECTURE「核心抽象 / Session 切换」。



### Pre-warm 机制

MCP / Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步**不**触发。持久 Session 中 pre-warm 即最终 session，用户消息通过 `wakeGenerator()` 注入。**任何 `!preWarm` 守卫都可能在持久模式下永远不执行。**



**MCP 配置权威来源 = 磁盘**：CLI `zhishi mcp` 写盘，sidecar self-resolve 从磁盘读。混用 / 不一致会导致 fingerprint 差异 → abort → 30s 重启循环。



### 模型供应商（1.1.5 多模型接入）

- 内置 8 家：`anthropic-api`、`deepseek`（anthropic 兼容端点）、`openai`、`moonshot`（Kimi，OpenAI 格式）、`dashscope`（通义）、`zhipu`（智谱）、`siliconflow`（硅基流动聚合）、`kimi`（pi 内置 kimi-coding，合成条目）。定义在 `src/shared/config-types.ts::PRESET_PROVIDERS`——新供应商照此结构加（`apiProtocol: 'openai'` 即走 OpenAI completions；pi 按 `Model.api` 显式选协议，不做 baseUrl 探测）。
- 模型列表拉取：`src/server/utils/provider-models.ts`——`modelListUrl` 优先（set-key 后自动拉取，`parseProviderModelsResponse` 兼容 OpenAI/anthropic 双形状，上限 200 条）；失败降级不阻塞。发现模型写 `config.presetCustomModels`。
- 配置入口：CLI `zhishi model set-key/list/verify/set-default`；TUI `/model`（状态卡）/ `/model set-key <id>`（隐藏输入填 key）/ `/model use <id> <模型>`（切换，`/chat/model` 带 providerId 防跨供应商撞名）。
- MCP 开关进 TUI：`/mcp enable|disable <id>`（复用 mcp/enable、mcp/disable + 桥热重载）；add/remove 仍走 CLI（OAuth/多形态 spec 不适合 TUI 输入行）。

- `intel.db`（`~/.zhishi/`，better-sqlite3，WAL）：NVD CVE（窗口分级 minimal/window/full，默认 minimal）+ exploit-db 索引（只存 CSV 索引行，PoC 文件不落盘）+ nuclei 模板索引（1.1.4：`nuclei_templates(cve_id, template_path)`，只存目录不存正文——模板内容给 GitHub 链接）。FTS5 全文检索，查询按需直查库、不做启动预载。
- 更新：`zhishi intel update [--mode minimal|window|full] [--nuclei-file <本地 cves.json>]`（走 sidecar admin API）。NVD 走 API 2.0 增量（lastModStartDate 水位）+ 断点续传；exploit-db 拉 GitLab CSV 整体替换（解析层按 id 首行去重——真实 CSV 有重复行）。**网络错误/超时/响应体读取失败都进指数退避重试**（NVD 单页 6.4MB，慢网络实测 90s+，超时 120s）；`maxSizeMb` 超限删最旧。
- nuclei 同步（1.1.4）：**多源 fallback**——raw.githubusercontent → cdn.jsdelivr.net → api.github.com 普通 contents API（base64 解码；本机网络实测：node 进程对 raw/jsdelivr/gitlab 域超时、api.github.com 普通 API 稳定）。`--nuclei-file` 本地导入兜底（网络不通时宿主 curl 下载后喂入）。全部源失败保留旧数据进 warnings。
- 更新并发互斥 + 进度（1.1.4）：update 进行中第二个 update 立即拒绝（「已有更新在跑」）；`intel/status` 带 progress（inProgress/currentWindowLabel/nvdAdded/exploitCount），CLI 每 3s 轮询实时显示「已入库 N 条」（不做百分比——拉取前总量未知）。
- 工具：loop `intel_search`（宿主侧认知供给，与 research_log 同层、无条件注册）——精确 CVE / FTS 模糊 / exploit 关联查询；精确 CVE 命中时联查 nuclei 模板（截断 5 个，给 GitHub 链接）；本地未命中按 `intel.onlineFallback` 回源 NVD（5s 超时静默降级）；结果 ≤5 条 × ≤200 字，带「索引最后更新于」提示。情报是线索不是结论——工具 description 已写明使用纪律。
- 配置：`config.json` 的 `intel: { mode, windowYears, maxSizeMb, onlineFallback }`（`src/shared/config-types.ts` 的 resolveIntelConfig）。



### 会话按环境分线（1.1.6）

- 每个环境一条独立会话线：映射文件 `~/.zhishi/env-sessions.json`，行键 = `${规范化workspace}::${环境键}` → loopSessionId（`src/server/environment/env-sessions.ts`，写走 withFileLock + tmp+rename）。环境键：env → `env:<id>`、recipe → `recipe:<instanceId>`、host → `host`；workspace 键一律 resolve + 统一正斜杠（斜杠漂移是活体坑）。
- 联动：`environment/select` busy 前置闸（先于落盘，「响应进行中，先 Esc 停止再切换环境」）→ 落盘 → `switchEnvSession` 切线（有映射接线/无映射开新线/同环境幂等；旧线先回填映射防丢）。新线的映射写盘点在 `ensureSessionBound` 绑定之后——映射永不指向无绑定的线。
- 启动恢复 env-aware：引擎 `restorePiSession` + TUI `ensureAgentSession` 都按「当前选定环境」接线；「按全 workspace 最新 meta 接线」旧语义已废除（分线下最新多半是别的环境的线）。`resetPiChat` 同步清当前环境键的映射（防旧历史复活）。cron 不特殊处理——跟随当前选定环境的线。
- TUI 正门（gate）：`enterGate()` 入口必须重置 `gateBusy`（成功路径不复位曾致 /env 二次进门吞掉全部按键）；Esc 语义按来源区分——startup 退出到 shell，/env 重进返回 chat（`gateReentry`）。
- 鼠标捕获（1.1.6 受控恢复）：writer enter 开 `?1000h+?1006h`、exit 关；keymap 只放行滚轮码 64/65，点击/拖拽继续吞掉（防点击误判 Esc 中断 turn）。取舍：终端原生拖选需按住 Shift。



### Agent Runtime

**唯一 loop 引擎 = pi（自研 loop，`src/server/loop/`）**。Claude Agent SDK 已随 D25/M4c 删除（agent-session.ts 裁留元数据层）；外部 Runtime（Claude Code CLI / Codex CLI / Gemini CLI）早已随 D20 删除。存量 config 的 `agents[].runtime` / `runtimeConfig`、task 的 runtime/model 之外 override 字段静默忽略、数据留盘（见 `docs/security_researcher_agent_tech_plan.md` §10.3）。cron 的 `completed` gate 仍 MUST 打在真·turn 成功上（`!getAndClearLastAgentError()`），别只凭 `waitForSessionIdle`。



### 定时任务系统

Rust `CronTaskManager` 统一管理所有定时任务（独立创建 / AI 工具 / Heartbeat；Chat 定时与 IM Cron 已随 GUI / IM 删除）。AI 驱动的 cron run 的退出由 per-session cron context map（`src/server/tools/cron-tools.ts`）判定。新增 `CronTask` 字段 MUST 带 `#[serde(default)]`。详见 ARCHITECTURE「定时任务系统」。



### Config 持久化（disk-first）

`AppConfig` 权威来源 = 磁盘（`config.json`），内存副本可能不同步。写盘 MUST 以磁盘为准（`await loadAppConfig()` 读最新再合并），**禁止**拿内存副本直接写盘。



### Builtin MCP 懒加载

内置 in-process MCP 采用 META / INSTANCE 两层懒加载（gemini-image / edge-tts / im-bridge-tools 已删除；cron-tools 等已于 v0.2.11 退役）。`src/server/tools/*.ts` **禁止顶层 value-import** SDK / zod（结构性 ESLint 规则封禁）。MUST 在 `createXxxServer()` 内部 `await import(...)`。详见 `tech_docs/pit_of_success.md` 的「Builtin MCP 懒加载」节。



### 工作区路径安全（path_safety）

W6 减法后 `cmd_workspace_*` invoke 命令层已整体删除（无 renderer 消费方），`src-tauri/src/workspace_files/` 只剩 `path_safety`——它是 sidecar / panel_api 共享的路径校验核心：

- **读侧**用 `path_safety::resolve_existing_inside_workspace`（canonicalize + prefix-check 防 `evil_link → /etc/passwd` symlink 逃逸）

- **写侧**用 `path_safety::resolve_inside_workspace`（lexical，因 `fs::canonicalize` 在不存在路径上失败）

- **绝对路径揭示**走 `cmd_open_path_external`，挡 home/tmp prefix + credential 黑名单

- **fs watcher** 用 token-based handle：`watch_start` 返回 `{token, eventKey}`，`watch_stop({token})` 索引；token 为进程内自增计数器（不落盘，故无跨重启碰撞面——若未来出现持久化 token 的路径，需加进程 nonce，见 watcher.rs:55 的决策注释）



详见 ARCHITECTURE「工作区文件 IO」。



### 记忆系统（memory.db 唯一事实源 + 蒸馏弧 + 土匪回路）

SQLite `~/.zhishi/memory.db` 是唯一事实源（`memories` / `archive` / `trust_events` / `recall_events` / `research_events` 表，存取见 `src/server/memory/store.ts`）。灵魂/认知层零 md——旧 md 文件只作一次性迁移源，导入 db 后不再读。

- **蒸馏弧**（说人话：定时跑的系统任务，把最近的原始工作史压成恒定尺寸的认知摘要——工作史无限长，注入永远 ~6KB）：两条并行弧、均用户不可见——**认知弧**每小时压全局工作史（`memory.distill.enabled=false` 时不播种，纯逻辑 `src/server/memory/distill.ts`）；**安全蒸馏弧**每 6 小时把研究成败信号（`research_events` 表，由 `research_log` 研究留痕写入）按研究域（task_kind）分隔蒸馏、经验不跨域（纯逻辑 `src/server/memory/distill-research.ts`）。LLM 调用 / cron 路由 / 写盘外壳均在 `distill-runner.ts`；两条弧的蒸馏产物逐 turn 反喂进 system prompt（`chat-engine.ts`）。

- **土匪回路**（说人话：agent 检索记忆的效果验收闭环——"被展示过"不算数，"真有用 / 闯祸了"才结账）：`zhishi memory search`（agent 检索通道）命中落 `recall_events` 日志（被展示≠有效，不动分）→ 蒸馏弧 judge 看引用后的真实对话片段做效果门控结算（effective 弱正；wrong 重罚——写错一条会被未来无数次引用、持续反塑行为，比漏记危险；unused 不动分，靠时间衰减收拾；一次错误=一次结算，同 tick 不重复罚）→ 错记忆史注入蒸馏 prompt 做上下文学习。

- ~~persona 维度化~~（已移除，2026-08-17）：安全研究 harness 无陪伴人格——操作身份由安全认知内核承载（`system-prompt-security.ts`），`persona_docs` 表/persona read|write 路由/`novo/` 目录/人格注入段全部删除。"它眼中的你"归蒸馏弧（memories 表 user-model），不受影响。



### AI 可见面板（Panel API）

Rust 侧 `src-tauri/src/panel_api.rs` 起 127.0.0.1 axum 服务（随机端口，tmp+rename 原子发布到 `~/.zhishi/panel-api.port`），驱动**用户可见**的内嵌终端（共事不代劳：操作发生在用户眼前）。AI 侧入口是 CLI：`zhishi term open/write/read/close`；sidecar 只做薄代理转发（`admin-api.ts::handlePanelProxy`），让 CLI 维持单端口约定。

W6 减法：内嵌浏览器（`browser.rs` + panel_api `/browser/*` 路由 + `zhishi browser` CLI）已删——无窗口宿主里子 webview 拿不到父窗口，运行期必失败。



---



## Pit-of-Success 红线总表



每条：禁止 / 后果 / 正确做法 / Lint。**违反任意一条都会引入难诊断的生产事故**。详细 rationale 与 helper API 见 `tech_docs/pit_of_success.md`。



**Lint 列含义** — 工具自动拦截违规的就在这里标记：

- `clippy` — `src-tauri/clippy.toml` 的 `disallowed-methods` / `disallowed-macros`，违规时 `cargo clippy` 报错（CI 强制）。

- `eslint` — `eslint.config.js` 的 `no-restricted-imports` / `no-restricted-syntax`，违规时 `npm run lint` 报错（CI 强制）。

- `depcruise` — `.dependency-cruiser.cjs` 的架构边界规则，违规时 `npm run lint:deps` 报错（已串入 `npm run lint`）。

- `—` — 没有自动 lint，仍是文档约束。靠 review / `tech_docs/` 兜底。**不是不重要**，是因为规则形态（路径作用域 / 跨多语句模式 / 设计原则）静态分析做不准。



**LLM 读 lint 报错时的注意事项**：每条 lint message MUST 解释"违规会发生什么 + 正确做法是什么"两件事——不要只读"用什么 helper"就照搬，先核对这条规则的 *症状* 是不是你的场景。新加 lint 时也按这个格式写，不要省 WHY，因为 LLM 是主要读者。



| 禁止 | 后果 | 正确做法 | Lint |

|------|------|---------|------|

| 裸 `reqwest::Client::new()` 连 localhost | 系统代理拦 localhost → 502 | `crate::local_http::builder()` / `json_client()` / `sse_client()` | clippy |

| 裸 `std::process::Command::new()` | Windows GUI 弹黑色控制台窗口 | `crate::process_cmd::new()` | clippy |

| 裸 `tokio::spawn` / `tokio::task::spawn` | macOS startup-abort（panic 跨 FFI 不能 unwind） | `tauri::async_runtime::spawn` | clippy |

| 同步 `#[tauri::command] pub fn` 里做会阻塞 >1 帧的工作（等 sidecar 就绪 / 轮询 / 网络 / 大量文件 copy / kill+wait） | 同步 Tauri 命令跑在主线程 → 阻塞期间事件循环冻结（GUI 时代实战 #0.2.31：`cmd_ensure_session_sidecar` 同步等 sidecar 冷启动 ~800ms → 整个 WebView 卡死；窗口虽删，主线程阻塞仍会拖住托盘 / Panel / sidecar 管理回路） | 改 `pub async fn` + 把阻塞部分丢进 `tauri::async_runtime::spawn_blocking`（先把 `State` 里的 Arc clone 出来，**别跨 `.await` 持 State guard**）。快速查表 / getter 类同步命令不受影响，无需改 | — (静态判不出某命令是否阻塞，靠 review；改阻塞命令时必查) |

| 子进程 spawn 不调 `apply_to_subprocess` | Node fetch 读继承的 HTTP_PROXY → localhost 通信被代理 → 502 | `crate::proxy_config::apply_to_subprocess(&mut cmd)` | — (语义检查难自动化) |

| 裸 `which::which()` 查系统工具 | Finder 启动时 PATH 缺失 | `crate::system_binary::find()` | clippy |

| Tauri `resource_dir()` / `current_exe()` 路径直接喂 Node / npm / URL / 子进程 | Windows `\\?\` 长路径前缀让 `fileURLToPath` / spawn 报 `ERR_INVALID_FILE_URL_PATH` 或静默挂 | `crate::sidecar::normalize_external_path(p)`，在路径"出 Rust 边界"前剥前缀 | — (路径来源动态) |

| `~/.zhishi/config.json` 裸 `tmp + rename` | 多写者 race，密钥静默丢失 | Node `withConfigLock` / Rust `with_config_lock` | — (路径作用域，banning all `fs::rename` 噪音过大) |

| 单写者文件裸 append / read-modify-write | 应用内多 owner race | `withFileLock` / `with_file_lock` / `with_file_lock_blocking` | — (writer-pattern 依赖) |

| Runtime 子进程 stop 用裸 `SIGTERM + waitForExit` | 进程拒收 SIGTERM 时永久卡死 | `killWithEscalation` | — (跨多语句模式，false-positive 高) |

| 工具裸 `fetch()` 无 AbortSignal | 下游卡住 → tool turn 永久 hang 直到 OS TCP 超时（分钟级） | `cancellableFetch` / `withAbortSignal`（`@/server/utils/cancellation`，默认 30s 超时 + parentSignal 传递） | eslint (`src/server/tools/**`) |

| 大 payload（>256KB）直接进 SSE / IPC JSON | OOM / 客户端卡死 / 慢 client 拖死 sidecar | `maybeSpill` + `/refs/:id` + SSE 优先级队列 | — (运行时 size 判定) |

| 同步 busy-wait（`Atomics.wait` / spin / `while Date.now()`） | 阻塞 event loop / Sidecar 停止 drain 引擎消息 / pegs CPU | 异步 polling / 现成 helper（`setTimeout` / `withFileLock`） | eslint (`Atomics.wait`) |

| readiness 等同 liveness | 客户端假就绪 | `/health/{live,ready,functional}` 三分；客户端挂 `/health/ready` | — (语义检查) |

| `src/server/tools/*.ts` 顶层 import SDK / zod | builtin MCP 懒加载失效，冷启动每次税 ~500–1000ms（6 tools = ~3–6s） | factory 内部 `await import(...)` | eslint |

| 直接设置 `shouldAbortSession = true` | 跳过 abort cleanup 链（pending 救援、generator 唤醒）→ 消息永久 hang | `abortPersistentSession()` | eslint |

| ~~给 SDK 传 `allowDangerouslySkipPermissions:true` 后假设 `permissionMode:'plan'` 仍拦写；用 per-agent `permissionMode` / `canUseTool` 拦 `run_in_background` 子 Agent；plan / 后台 Agent 的 hook 硬闸（`plan-mode-gate.ts` / `background-agent-permission.ts`）~~（SDK 已随 D25/M4c 整体删除，本行机制随之作废；权限边界现由 `loop/boundary.ts` 入向 deny + `loop/output-guard.ts` 出向净化承担，规则即数据、零问人交互） | — | — | — |

| 函数参数用 `undefined` / `null` 表特定动作 | 内部调用方误触发 | 自解释字面量（如 `'subscription'`） | — (设计原则) |

| 后端 `broadcast()` 新增 SSE 事件不注册优先级表 | 未注册事件按默认 critical 处理，背压下不 coalesce、且每进程刷 missing-from-priorities 警告；历史上 renderer 白名单漏注册曾让事件被静默丢弃、功能死亡无报错（F-01 实战） | 在 `src/server/sse.ts::SSE_EVENT_PRIORITIES` 注册；`sse-whitelist-crosscheck.unit.test.ts` 把「broadcast 字面量 ∉ 表」变成单测红灯 | — (单测对账) |

| Sidecar 用 `__dirname` | esbuild 硬编码路径到源文件位置 → 运行时落到不存在/陈旧的 dist/ 路径 | `fileURLToPath(import.meta.url)` / `getScriptDir()`（`@/server/utils/runtime`） | eslint (`src/server/**`) |

| Sidecar 用 `readFileSync(path.join(__dirname, ...))` 读 bundled 资源 | 同上 | 内联常量 / `fileURLToPath(import.meta.url)` 算路径 | — (`__dirname` 已 lint，`readFileSync` 本身有大量合法用途) |

| 日志日期用 UTC `toISOString().split('T')[0]` | UTC 与本地日期在 UTC+8 有 1/3 时间不匹配 → 日志写错文件，按"今天的日期" grep 找不到 | `localDate()`（`@/shared/logTime`） | eslint |

| Rust 日志用 `log::info!` / `warn!` / `error!` / `debug!` / `trace!` | 不进统一日志（`~/.zhishi/logs/unified-{date}.log`），"读 unified log" 的排查红线失效 | `ulog_info!` / `ulog_warn!` / `ulog_error!` / `ulog_debug!` | clippy |

| 工作区文件 IO 走 sidecar HTTP（`/api/files/*`、`/api/commands`、`/api/git/branch` 等 18 个端点——**已全部下线（v0.2.7 Phase E）**；承接它们的 Rust `cmd_workspace_*` invoke 层也在 W6 减法中随 renderer 删除） | sidecar 未就绪时文件能力直接死掉；把"AI runtime 容器"和"OS 文件操作"耦合，云端协作时分不开 | 残留共享校验逻辑在 `src-tauri/src/workspace_files/path_safety.rs`（sidecar / panel_api 在用） | — (端点与 invoke 层均已下线，规则留档防回潮) |

| 依赖用户系统安装的运行时 | 用户未装 → 功能不可用 | 内置 Node.js（`runtime.ts::getBundledNodePath()`） | — (设计决策) |

| 用 `existsSync` / `Path::exists()` 当"路径上有没有东西"探针，紧接着 `cpSync({recursive:true})` / `fs::create_dir_all` / `fs::remove_dir_all` 跑过去 | 跟随 symlink 语义 → **断链 symlink 返回 false** → 代码以为不存在 → Node v24 `cpSync` 走进 `std::filesystem::equivalent` 抛**未捕获 C++ 异常**（`libc++abi: filesystem error: in equivalent: Operation not supported`），JS try/catch 接不住，整个 sidecar abort，Tauri 健康检查重启 → 死循环（v0.2.5 实战：`~/.zhishi/skills/docx` 是断链让全局 sidecar 起不来）。注意 async `fs.cp` 不崩，**只有 sync `cpSync` 崩** | 在跑写操作之前 MUST 用**不跟随 symlink** 的 API 探：Node 用 `lstatSync` + `existsSync` 双探（`isSymbolicLink && !existsSync` ⇒ 断链，先 `unlinkSync`），Rust **MUST 用 `fs::symlink_metadata`，不要用 `fs::metadata()`**（后者跟随 symlink 与 `Path::exists()` 同病）；拿到 `Metadata` 后 `is_symlink() \|\| is_file()` → `remove_file`，是目录 → `remove_dir_all`。修复样板见 `src/server/index.ts::seedBundledSkills` 与 `src-tauri/src/commands.rs::cmd_sync_system_skills` | — (跨语句模式) |

| 1M 窗口 model id 进引擎时丢上下文窗口元数据（SDK 时代的 `query({ model })` / `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` env 与 `applyContextWindowSuffix` helper 均已随 D25 删除） | 1M 窗口模型（claude-opus-4-7 / claude-opus-4-6 / deepseek-v4-pro / gemini-2.5-pro / gpt-5.4 ……）退回引擎保守 200K 兜底、auto-compact 提前触发。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 只能 `Math.min` 下调不能上调，对 ≥1M 模型彻底无效。注意 `claude-sonnet-4-6` 不在此列：Anthropic Sonnet 4.6 wire-default 200K，1M 需要 `context-1m-2025-08-07` beta header + Tier-4 配额或"extra usage"付费开关，订阅默认开 1M 会触发 `Extra usage is required for 1M context` 报错（v0.2.11 修复，预设 contextLength 已降回 200K） | 窗口大小由 `loop/pi-provider.ts::buildLoopModel` 的 `contextWindow` 显式传入（缺省 200_000 保守值）。所有用户可见处用未 wrap 的原始 model id（`[1m]` 后缀剥离语义见 `src/shared/contextUsage.ts::stripModelSuffix`） | — (DOM 层级注入位置无固定 AST 形态，靠 review 兜底) |

| 工具产物的图片 / 音频 / PDF 等富媒体走 `tool_result.content` 字符串 | 大 base64 直接进 SSE → 撞 256KB 红线；富媒体产物无法归一化归档 / 复用 | 走协议层一等公民 `tool_result.attachments: ToolAttachment[]` 落盘到 `~/.zhishi/generated/tool-attachments/<sid>/<tid>/<file>`。注：D20 后服务端唯一的附件生产者（codex runtime 的 `runtimes/tool-attachments.ts`）已随 external runtime 删除，该通道当前无生产者，仅保留类型与落盘目录约定。（文档已随 D20 同删，git 历史可查） | — (设计层模式) |

| 攻击者控制的绝对路径直接进 `validateExternalReadPathNode(path)`（`canonicalizeSymlinks: false`）后引用为 attachment | symlink 逃逸：`~/.codex/sessions/evil_link.png` → `/etc/passwd` lexical 检查通过 → endpoint 流回敏感字节 | 读侧 MUST 用 `canonicalizeSymlinks: true`（默认），`fs.realpath` 解析后再过 blacklist；并 `lstatSync.isSymbolicLink()` 拒绝 symlink leaf；外部路径还要过 `isAllowedExternalAttachmentPrefix` positive allow-list（仅允许 `~/.codex/` `~/.zhishi/` `~/Documents/` 等）。（文档已随 D20 同删，git 历史可查） | — (语义检查，靠 review) |

| URL 下载（`dynamicToolCall.imageUrl` 等 prompt 可控的 URL）直接走 `cancellableFetch(url)` 不限 scheme / 不挡私网 | SSRF：恶意 MCP 工具用 `http://169.254.169.254/...`（AWS metadata）或 `http://127.0.0.1:.../` 让 sidecar 当跳板 | 已删除的 `tool-attachments.ts::downloadAndSaveUrl`（D20）曾限定 `https:` + 拒绝 loopback / RFC1918 / 169.254/16 / IPv6 ULA + `redirect: 'error'`——该通道无生产者，规则保留为模板。新增"prompt 可控的 URL 下载"路径 MUST 同样校验 | — (调用方语义) |

| Node 端 path-safety 黑名单（`src/server/utils/path-safety.ts`）与 Rust `commands::validate_file_path` 不同步 | 两侧任何一边新增 credential dir 后，另一边静默放行 → 攻击面 | 改一处 MUST 同步另一处。已有双向对账：共享 fixture `src/shared/path-safety-blacklist.json` + Node `path-safety-crosscheck.unit.test.ts` + Rust `path_safety_crosscheck_tests` | — (跨语言同步) |

| 比较工作区路径（`Project.path` ↔ cron/task `workspacePath` / session `agentDir` / config `defaultWorkspacePath`）用 raw `===` 或 inline `.replace(/\\/g,'/')` | Win 上 `projects.json` 存反斜杠、cron/session 存正斜杠 → 永不相等且**静默**：#320 定时任务"升级为新版任务"全报"找不到工作区" | `workspacePathsEqual(a,b)` 谓词 / `normalizeWorkspacePathIdentity(p)` 做 Set·Map 键（TS `src/shared/workspacePath.ts`，Rust 端口 `src-tauri/src/utils/workspace_path.rs`（2026-08-06 补齐，自带单测）；键 build+lookup 两侧都要过）。详见 `pit_of_success.md`「workspacePath」 | — (语义，靠 review) |



### 架构边界（dependency-cruiser 强制）



`.dependency-cruiser.cjs` 把模块图边界变成 lint。`npm run lint` 串入了 `lint:deps`，违规 CI 直接 fail。



| 禁止 | 后果 | 正确做法 |

|------|------|---------|

| `src/server/tools/*` import `agent-session.ts` | 重新触发 builtin MCP 懒加载架构想避免的 cold-start 单例税；或者形成循环（agent-session 反过来调 tools 注册 MCP） | 把 tool 需要的数据通过 `createXxxServer()` 工厂参数传入，不要顶层 import |

| `src/server/tools/*` 互相 import（除 `builtin-mcp-registry.ts` / `builtin-mcp-meta.ts`） | 耦合各自的懒加载生命周期，可能复活每个 tool ~500–1000ms 的 eager-load 税 | 共享 surface 通过 registry / meta 文件 |

| `src/shared/**` import server / cli | shared 被 server 与 cli 两侧消费，必须保持纯净。引入 process-specific dep 会让另一侧 bundle 崩，或把错误 runtime 代码塞进错误 bundle | 进程特定的代码放 `src/server/shared` 等对应侧目录 |

| 静态循环依赖（不经 `lazy(() => import(...))` 打破） | 模块 init 顺序不确定（一边在 module-eval 时看到 `undefined` 而非 export，第一次调用时才崩）+ bundle 膨胀 | 抽出共享接口到第三个 leaf 模块；用 `lazy(() => import(...))` 打破是 OK 的 |



---



## 开发命令



```bash

npm install                       # 依赖安装（v0.2.0+ 统一 npm）

npm start                         # 别名 npm run server（sidecar 直接启动需 --agent-dir，见下；原 npm run dev / dev:web / build:web 已随 GUI 删除）

node --import tsx/esm src/server/index.ts --agent-dir <dir>   # sidecar（--agent-dir 必填）

node --import tsx/esm src/cli/zhishi.ts agent                  # agent 全屏 TUI（ZHISHI_PORT 指向 sidecar 端口）

npm run tauri:dev                 # Tauri 开发模式（无窗口：sidecar Owner / 托盘 / Panel API / Management API）

./scripts/dev/build_dev.sh        # Debug 构建

./scripts/build/build_macos.sh    # 生产构建

./scripts/release/publish_release.sh  # 发布到 R2

npm run typecheck                 # 代码质量检查（提交前 MUST）

npm run test:unit                 # 快池（纯逻辑，并行，秒级）— 开发回合中频繁跑

npx eslint src/server src/shared src/cli   # scoped lint（整库 lint 现状见下方已知遗留）

npm run test:changed              # 只跑受未提交改动影响的测试

npm test                          # 全套（unit + stateful 串行池，含真实引擎/IO，~3min）

npm run coverage                  # 覆盖率报告（不设硬阈值，看改动文件 ratchet）

```



**本机环境**：node 不在 PATH，使用 `/d/ZhiShi/nodejs`（如 `/d/ZhiShi/nodejs/npm run typecheck`）。



**已知遗留（安全研究员版转型后待补验）**：

- 本机无 Rust 工具链，`cargo check` / `clippy` 未跑——src-tauri 大量改动（lib.rs、management_api.rs、task*.rs、sidecar.rs、commands.rs、cli.rs、i18n.rs、search/mod.rs）待补验；`Cargo.lock` 未 regenerate（转型删除了 4 个 crate：tokio-tungstenite / prost / pulldown-cmark / futures）。

- 整库 `npm run lint` 因 `terminator/` 子项目 349 个既有 eslint 错误红灯（非本次转型引入）；日常验证用上面的 scoped lint。



## 测试纪律（回归护栏）



测试用 Vitest，拆两个 project（见 `vitest.config.ts`）：`unit`（纯逻辑，node env，并行 forks，秒级，含 `src/shared/**` 的 `*.test.ts`、server 侧 `*.unit.test.ts`）+ `stateful`（singleFork 串行，其余 `src/server/**/*.test.ts`，触碰模块级全局/端口/真实引擎）。Rust 测试走 `cargo test`（独立，`npm test` 不碰）。GUI 时代的 `dom` 池（jsdom / `*.test.tsx`）已随 renderer 删除。



**这套测试存在的唯一目的是在快速迭代中拦住回归**。AI 开发时 MUST 把它当成开发回合内的护栏，主动跑、即时修：



- **改纯逻辑后 MUST 跑 `npm run test:unit`**（秒级，无理由不跑）；改后端核心后跑 `npm run test:changed`。

- **修 bug MUST 先加一个能复现该 bug 的回归测试**（characterization test）让它先红，再修到绿——把"反复出同类 bug"从根上掐断。这是红线，不是建议。

- **新增红线 helper / 纯函数 MUST 配单测**（放进 `unit` 快池：`src/shared/` 直接 `*.test.ts`；server 侧用 `*.unit.test.ts` 后缀进快池）。

- **测试红了不许靠改弱断言/`skip` 糊过去**——先判断是产品 bug 还是测试漂移（拿确凿依据），产品 bug 就修产品代码。订正不变量必须有理由。

- 写"纯逻辑可单测"的代码：把决策逻辑抽成纯函数（Functional Core / Imperative Shell），副作用留在薄外壳。巨型文件（`agent-session.ts`）的新逻辑优先抽纯核心再测。

- 涉及时间的测试 MUST 注入时钟 / `vi.useFakeTimers`，涉及本地日期的 MUST pin `process.env.TZ`（否则跨时区/CI flaky）。



CI（`.github/workflows/test.yml`）在 PR + push 到 `dev/*`/`main` 时自动跑 typecheck + lint + `test:unit` + `cargo test` + clippy（`-D warnings`），**不过不让合**。



## Git 与工作流



- **提交前 MUST**：`npm run typecheck` + `npm run test:unit`（秒级），检查当前分支（`git branch --show-current`）

- **并发 writer 纪律（本仓库常态）**：working tree 可能被并行 session / 用户同时改，会话开始的 git 快照是**冻结的**、不反映实时树。提交前 MUST 重跑 `git status`；**禁止 `git add -A` / `git add .`**——显式列出只属于你的文件；对改过的文件用 `git diff -- <file>` 确认没混入别人的 hunk（混了就别整文件 stage，隔离自己的 hunk 或先协调）；验证后**尽快提交**（拖延会被并发 `commit -a` 把混合文件卷走）。**禁止** `checkout HEAD -- <file>` / amend 共享 commit 去"清理"——会毁掉对方未提交工作，改用追加 commit。whole-tree `npm run lint` / `typecheck` 可能因别人未提交代码报错，用 `npx eslint <你的文件>` 自查

- **发布前验"已提交态"而非工作树**：并发 writer 可能提交了组件改动、却把配套测试 fix 留在工作区 → **已提交分支是红的，但你本地 `npm test` 因工作区 fix 而绿**（0.2.29 实战：`SimpleChatInput` 的 `useConfigData` 改动已提交、其测试 mock 未提交 → 已提交态 `useConfigData must be used within <ConfigProvider>`）。合 main / 打 tag 前 MUST 先 `git stash` 掉无关工作区文件（或确认 `git status` 干净）再跑易红测试；load-bearing 的未提交 fix 就显式提交进发布准备，别 ship 红分支

- **分支策略**：`dev/x.x.x` 开发 → 合并到 `main`。MUST NOT 在 main 直接提交

- **合并到 main**：需 typecheck + lint 通过 + 用户明确确认

- **Commit 格式**：Conventional Commits（`feat:` / `fix:` / `refactor:`）

- **Commit message 写什么**：diff 已经说清「改了什么」，message 别重复它，专心写「为什么」——为什么要改、为什么这么改而不用那个更显然的办法、有哪些后人不能踩的坑。它是写给半年后来翻这段历史的人（或 AI）看的，不是写给此刻的自己。内容必须和真正提交的代码一致，别写没做、或后来又改掉的事。长短随改动而定：错别字一行就够，微妙的 bug、架构取舍值得写一段。别写 `fix`、`update`、`wip` 这种等于没写的，也别一次提交里混进好几件不相干的事。

- **发布流程**：先更新 CHANGELOG.md → `npm version` → `./scripts/build/build_macos.sh` → `./scripts/release/publish_release.sh` → push tag



## 日志与排查



日志来自两层（Node.js Sidecar / Rust），汇入统一日志 `~/.zhishi/logs/unified-{YYYY-MM-DD}.log`。**用户报告问题时 MUST 主动读日志，不等用户粘贴。**



- **AI / Agent 异常**：搜 `[agent]` `pre-warm` `timeout`

- **定时任务**：搜 `[CronTask]`

- **终端**：搜 `[terminal]`

- **Rust 层**：额外查 `~/Library/Logs/com.zhishi.app/ZhiShi.log`



详见 `tech_docs/unified_logging.md`。



---



## CLI 与系统技能（修改约束）



`zhishi` CLI 是产品能力的统一入口——所有 session（交互 agent / Cron）都经它驱动 ZhiShi 的产品能力。官网位于 `output/zhishi-landing/`（正被重新设计为「zhishi 执失 Security Research Lab」）；原 **ZhiShi Admin Service**（`output/zhishi-ticket-service`，埋点/广告/插件注册表/版本统计）已移出本仓库。（注：需求单 / 客服工单链路已删除——`zhishi support requirement`、`supportUserToken` 等均不存在，勿再引用；内置 MA 小助理亦已退役——`bundled-agents/zhishi_helper/` 与 `ADMIN_AGENT_VERSION` 均已不存在。）



- 修改 `src/cli/zhishi.ts` 或 `src/cli/zhishi.cmd` → MUST bump `CLI_VERSION`，并同步更新 `bundled-skills/zhishi-cli/SKILL.md`（CLI surface 变化必须在 skill 文档里反映出来）+ bump `SYSTEM_SKILLS_VERSION`

- 修改 `bundled-skills/` 中 system skill（清单见 `SYSTEM_SKILLS`） → MUST bump `SYSTEM_SKILLS_VERSION`

- 新增 system skill：(1) 放入 `bundled-skills/<name>/`；(2) 加入 Rust `SYSTEM_SKILLS` 和 Node `src/server/index.ts::SYSTEM_SKILLS` 两个清单；(3) bump 版本

- **utility skill vs system skill**：清单内 = system（强制更新）；其它 = utility（首次 seed 后归用户）



---



## Team Hub（已于 2026-08-06 移除）

Team Hub 服务端（`zhishi-hub/`）从未随本仓库分发，且已被确认完全删除；2026-08-06 经用户拍板，桌面端 Hub 客户端代码同步全量移除：`src-tauri/src/hub_client.rs`、management_api 的 `/api/hub/*` 路由、IM Hub 干预卡片链路（telegram `hi:` 回调等）、`hub-permission-escalation.ts` 升级链路、CLI `hub`/`team` 命令组、`teamHub` 配置块、Hub intervention UI（InterventionInbox 的 Hub 区块、HubInterventionAlerts、TaskHubInterventions 等）。

保留：IM 审批应答中心（`im:permission-request` + InterventionInbox 的 IM 区块 + 「人工」代回）与 Hub 无关，不受影响。task 数据模型里的 `dispatchTarget`/`remoteTaskId` 等字段作为 legacy 惰性保留（兼容磁盘旧数据，不再写入新值）。

（注：本节所述「保留」的 IM 审批应答中心，已随 2026-08 安全研究员版转型的 IM 全家删除而不复存在——见下节。）



## 安全研究员版转型（2026-08 大减法）



产品形态从「桌面 GUI 应用」转为 **CLI（`zhishi` 命令）+ agent 全屏 TUI，无窗口**，方向为安全研究员。以下能力已删除；代码或存档文档中如出现相关描述，均为历史残留：



- **renderer GUI 全家**：`src/renderer/`（React / Vite / Tailwind / xterm / monaco 等 40+ 前端依赖）、`npm run dev` / `dev:web` / `build:web` / `test:dom`、桌宠（pet.rs）。Tauri 不再创建任何窗口（保留 sidecar Owner、Panel API（仅 term）、Management API、CronTaskManager、托盘 exit、updater、统一日志；W6 减法进一步删除 SearchEngine / browser / sse_proxy / global_shortcut / 全部 IPC invoke 命令），`tauri.conf.json` 的 frontendDist 指向 `src-tauri/placeholder/` 极简占位页。

- **IM 全家**：`src-tauri/src/im/`、`src-tauri/src/inbox/`、`src/server/inbox/`、`src/server/plugin-bridge/`（OpenClaw Plugin Bridge）、im 工具三件套、CLI `im` / `session send` / `agent channel` / `agent runtime-status` / OpenClaw `plugin list|install|remove`。OpenClaw 渠道插件桥已随 IM 删除。

- **需求单（support/requirement）全链路**：admin-api handler、webhook、CLI 命令、`supportUserToken` 配置字段。

- **想法（thought）全家**：thought.rs、management_api thought 路由、CLI thought 命令、system-prompt 注入。

- **技能市场 / 安装管线**：`src/server/skills/` 整目录、CLI `skill add` / `skill sync`（`skill list/info/remove/enable/disable` 保留，list 只列用户级 `~/.zhishi/skills/`）；bundled-skills 从 13 减到 7（删 docx / pdf / pptx / xlsx / capability-forge / skill-creator）。

- **内置工具 gemini-image / edge-tts** 及其 media 附件链（`builtinMediaResult.ts`、`builtin-media-attachments.ts`；通用 ToolAttachment 类型保留，D20 后无服务端生产者）。

- **LLM provider preset** 从 16 收窄到 2：anthropic-api、deepseek（搜索 preset playwright / ddg-search / tavily-search 保留）。



保留核心能力：MCP enable 管线、AppCraft / cuse / terminator、memory 全套、task / cron 系统、CLI、panel_api.rs（仅 term 路由）/ terminal.rs、provider-probe / verify。（browser.rs 已在 W6 减法删除；openai-bridge 已随 D25/M4c 删除，OpenAI 协议 provider 由 pi 原生直连。）



产品方向细节见 `docs/security_researcher_agent_design.md` 与 `docs/security_researcher_agent_tech_plan.md`。



## AppCraft（工作区桌面自动化，PRD 0.2.36）



工作区可绑定 Windows 应用（`Project.boundApps`），agent 经两个互补引擎操作它们：



- **Terminator（UIA 语义通道，默认）**：mediar-ai/terminator（MIT）打包为内置 MCP preset `terminator`（哨兵 `__bundled_terminator__` → `src/server/utils/runtime.ts::getBundledTerminatorPath()`，Windows only）。选择器 `role:/name:/nativeid:`，动作走 UIA InvokePattern（不抢鼠标）。已知上游 bug（chcp 子进程污染 stdout）已在自构建二进制打补丁；分发走自构建 + R2 镜像（`scripts/download_terminator.ps1` / `scripts/build/publish_terminator_r2.ps1`）。
- **cuse（视觉兜底 + macOS）**：现有 preset 不变。



核心闭环：**录制**（`zhishi appcraft record start/stop` — Sidecar 消息流捕获工具调用 → `.appcraft/<id>/trace.json`）→ **沉淀**（`src/shared/appcraft-trace.ts` 变量抽取/参数化 → `.claude/skills/<name>/`）→ **无 LLM 回放**（`zhishi appcraft replay` — `src/server/appcraft/replay-engine.ts` 逐步驱动 terminator 选择器，vision 步骤走 cuse 原子命令，assert 校验）→ **失败自愈**（AI 修复后回写 trace）。GUI 时代的 trace.json 文件预览可视化（`src/renderer/components/appcraft/`）已随 renderer 删除。



工具映射 / 提速默认参数 / 已知环境风险（全屏无响应窗口会阻塞窗口管理）以 `src/server/appcraft/` 代码为准（旧 `specs/tech_docs/appcraft_engine_contract.md` 已随 specs/ 删除）。



---



## 求助 / 反馈



- `/help` — Claude Code 用法

- 反馈：https://github.com/anthropics/claude-code/issues

