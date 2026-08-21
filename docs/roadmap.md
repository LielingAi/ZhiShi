# Roadmap

> 版本任务池。1.0.0 = 安全研究员版定型（已完成）；当前线：1.1.x（能力补齐 + 引擎深化）。
> 状态约定：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。任务细节不写在这里——细节进对应设计文档。

---

## 1.2.1 —— 专家知识层·骨架期（进行中）

校准协作主线第一期：专家知识库。定位与边界经多轮对齐（用户拍板）：专家知识 ≠ skills（方法）≠ 蒸馏弧（LLM 自身经验）≠ intel 库（结果原料）；它是权威梯度的最高级、LLM 与用户都无能为力时的**最后落脚点**。完整方案（三期迭代 + 技术细节）：`docs/expert-knowledge-plan.md`。

- [ ] **库与检索**：`~/.zhishi/expert.db`（独立库，FTS5）+ loop 工具 `expert_search`（无条件注册，权威呈现与 intel「线索不是结论」对照）。
- [ ] **输入三通道**：agent 起草→drafts 表→`zhishi expert review` 人审（主通道）；编辑器往返（`expert new/edit`，crontab -e 模式，临时文件仅草稿介质）；`expert promote <eventId>`（蒸馏晋升，人改完保存=审定——LLM 知识变专家知识的唯一分界线）。
- [ ] **格式契约**：`validateEntry()` 单点校验（kind/domain 闭集、title/applicability/content/criteria 必填、provenance 通道写入、reviewer 条件必填），三通道全汇于此。
- [ ] **内置首批**：`bundled-expert/<domain>/*.md`（发行载体非存储，content_hash 幂等进库），每域 2-3 条，选题来自 dogfood 亲历卡点，宁少勿精。
- [ ] **时机教学**：内核一句权威语义（冲突时以专家知识为准并记录冲突点）+ 各域 skill 补「先尽力、卡住再查」。
- [ ] **验收**：对照实验——同一卡点任务跑两遍（无条目基线 vs 有条目），量脱困率/幻觉率；CLI 三通道各走一遍。

---

## 1.2.0 —— 研究交付：/export 一键出报告（已完成）

功能里程碑：把留痕设施（loop-sessions / research_events / 子代理 transcript）变现为可交付成果。TUI 单入口 `/export`（环境绑定与热连接只在会话在场时保证；CLI 不做）。组装逻辑全在 sidecar。细节与技术边见 `docs/1.2.0-design.md`。

- [x] **报告组装器**（server）：确定性骨架（事实钉死：事件流/证据/文件行号不许 LLM 碰）+ LLM 填肉（只写过程叙述）+ 按域模板（pentest/whitebox/二进制等骨架不同）。报告 = 目录（`output/reports/<slug>/`：report.md + evidence/）。
- [x] **证据回收链**：留痕纪律升级——research_log 挂 `trajectory_ref`（tool description + skills 双侧补「产出工件必挂路径」）→ 导出时按事件登记经 extract 通道批量回收到 evidence/；环境已下线 → 报告保留环境内路径 + 明确降级标注（transcript 内嵌证据兜底引用）。
- [x] **导出闸门**：批量一次批准（证据清单 + 落点一次列清，人批一次——不逐文件问）；敏感项清单（导出时列出 flag/密钥/IP 计数，知情在人）；默认完整导出，显式 `--sanitize` 才脱敏。
- [x] **验收**：pentest 域活体全链路 PASS（真实 SQLi→LFI 拿 flag → PoC 挂 trajectory_ref → 一次批准 → evidence/ 回收到 PoC 本体 → 报告含完整利用链）；whitebox 域 PASS（报告带 db.py:20/files.py:9/util.py:11——埋雷点全中）。

> 关键设计决策（2026-08-21 与用户敲定）：①报告=目录不是单文件（证据本体进 evidence/）；②脱敏版不是成果报告——默认完整，脱敏是显式选择；③TUI 单入口（脱离 TUI = 脱离环境）；④报告生成走独立一次性 loop，不占引擎单例会话线。
>
> 实际落地（2026-08-21）：新模块 `src/server/report/`（skeleton/templates/sensitive/narrate/evidence/export，纯函数+薄 IO 全注入）；`handleEnvironmentExtract` 的 scp argv 抽共享纯函数（原 handler 行为等价）；四域 skills + research_log description 补 trajectory_ref 纪律；TUI `/export [sanitize]`（进度/降级/脱敏插行）。全量 1820 测试绿（新增 41 例）+ typecheck/eslint/depcruise 干净 + smoke 5/5。已知限制：docker 环境证据回收走降级标注；报告叙述质量依赖填肉模型。

---

## 1.1.10 —— 子代理可审计 + app.ts 拆分（已完成）

- [x] **A′ 子代理 transcript 只读查看**（1.1.9 U1 的真落地——「完整进入子会话」已论证放弃，改只读查看，吃 90% 价值零导航语义）：服务端 delegate_task 补 `storeDir` 持久化（spawnSubLoop 半现成）+ `subagent-finished` 事件带 sessionId + loop-sessions 读取端点；TUI `/tasks` 详情页扩展为只读 transcript（每轮工具调用+输出+回复全文，可滚动）。验收：跑一个 delegate_task 子任务，/tasks 里能看到它的完整工作史。
- [x] **B app.ts 拆分**（1.1.9 留下的第一件事；照 1.1.7 手法，纯搬移不改行为）：slash 命令抽 `slash/`、overlay 收 reducer 模式（`model.ts` 的 reduceHiddenLine 是现成范式）、gate+manualForm 抽 controller；app.ts 只留路由+组装。验收：app.ts 行数大幅下降 + 全量测试绿（断言零改动）。
- [x] **C 搭车小项**：U5 工具卡多展开（drawer 可选目标，不只最新一个）；U8 状态栏 token 用量展示（usage 已收未展）。

> 方案论证（2026-08-21 与用户敲定）：「进入子代理会话」（完整切换/续跑）不做——导航语义膨胀、低频场景不值一套导航系统；只读 transcript 吃下审计证据链的核心价值。细节见 `docs/1.1.10-design.md`。
>
> 实际落地（2026-08-21）：A′ 服务端（storeDir 接通 + 事件带 loopSessionId + `GET /api/loop-session/messages` 端点，200 条/100KB 护栏）+ TUI（/tasks 详情 transcript 异步加载/滚动/缓存三态）；活体验收全 PASS（子代理跑 gcc 查证 → 事件带 loopSessionId → 端点读回完整工作史）。B 三刀 app.ts 1848→1258 行（slash/ 五文件 + overlay-reducer + gate-controller，四个 app 级测试零改动）。C 两项落地。全量 1779 测试绿 + typecheck/eslint/depcruise 干净 + smoke 5/5。

---

## 1.1.9 —— TUI 优化：性能基本盘 + 子代理可见性（已完成）

TUI（自研 v2）优化版。候选池全量摸底见 `docs/1.1.9-design.md`（每项带文件:行号证据）。本版**不做** `app.ts` 大拆分（H1）——与渲染管线改动并行会搅 diff，归下版。

- [x] **性能四件**：
  - P1 流式渲染 O(n²) → 尾部增量（每个 chunk 对累计全文重解析 markdown + 重折行；稳定前缀缓存，只重算末段）
  - P3 `Intl.Segmenter` 每次新建 → 模块级单例（一行，全链路受益）
  - P4 chrome 高度变化 → 全屏 invalidate+flush → 收窄 invalidate 范围 + flush 降级合帧
  - P5 resize 无防抖（拖窗口逐事件全量重折行）→ 走帧调度合帧
  - 验收：长回复流式尾部不掉帧（前后同任务对比帧耗时/CPU），全量 TUI 测试绿
- [x] **子代理可见性**：U1 修死按钮（完成行「要我切过去吗？(y)」按键路由无处理）+ U2 补 `/tasks` 面板（`bg-tasks.ts` 注释承诺过；列出 tasks/bgProcs、可选中看结论，复用 queue overlay 模式）。验收：按 y 切换生效；`/tasks` 列表/详情可用，窄终端不再静默丢信息
- [x] **小 UX 三件**：U3 Esc 清草稿可恢复（一次性恢复槽）；U6 回看键位接线（PgUp/PgDn 改 scrollPages 整页、补跳顶/回底键位——`scrollPages`/`scrollToTop` 已实现未绑定）；U7a 粘贴后触发补全（paste 路径补 `updateLiveCompletion`）
- [x] **卫生两件**：H2 状态栏 compose 重复两份合一处；H3 `as unknown as Block` 类型绕过改按 kind 精确工厂

> 实际落地（2026-08-21）：性能微基准（50KB markdown × 250 chunk，写屏字节逐字节相同）——帧均耗时 **52.2ms → 5.5ms**（P3 单例 −40%，P1 增量折行再 −83%；P1 正确性由 53 例 property 测试锁死：随机 chunk 切分下增量与全量折行逐 segment 深相等，含 grapheme 簇跨界修复）。U2 `/tasks` 面板落地（列表/详情两层，事件到达自动刷新）。**U1 方案变更**：核实发现「切过去」的服务端目标不存在（subagent loop 会话未持久化、无 sessionId 映射）——按预案移除误导文案、保留 switchHook 数据标记，真正的切换功能需服务端先补子会话持久化（归后续版本）。全量 1757 测试绿 + typecheck/eslint 干净；键位变化已同步 `docs/user-guide.md`。TUI 无活体驱动，真机手感（长回复流式、/tasks 面板）建议人工过一遍。

---

## 1.1.8 —— 三域 skills 实战验证（已完成）

产品深度版：pentest / whitebox / ai-security 三域 skills「声明齐、实战未验证」的欠账清零（原「未排版本」项收编）。binary 域已验证（ret2win），本版补三域。细节见 `docs/1.1.8-design.md`。

- [x] **whitebox 域实战**：造「埋雷代码库」夹具（小项目埋 3-4 个已知漏洞，内容只有出题人知道）→ agent 用 whitebox-audit skill 审计 → 验收：按决策链走完（选入口→基线扫描→确认→求证）且找出埋的雷。
- [x] **pentest 域实战**：造靶标服务（带已知漏洞的小 web 服务，跑在宿主机、VM 可达）→ agent 用 pentest skill 从 recon 开打 → 验收：走完「侦察→枚举→利用」决策链拿到 flag。
- [x] **ai-security 域实战**：靶标 = 自家 zhishi agent（应用层提示注入：工具返回/文件里埋指令，看 agent 是否被带跑）——自有产品，授权无瑕疵；顺手回答「自家产品抗不抗注入」。验收：探针集跑完 + 结果分级 + 报告留痕。
- 三域共用验收：各一条 dogfood 成功记录落 `research_events`；每域跑完按实战结果修正对应 skill（方法论缺口/工具问题/信号描述）。

> 授权口径（用户 2026-08-21 确认）：pentest 靶标为自造本机服务，ai-security 靶标为自家 agent——均在授权范围内，符合 skills 红线「目标人确认才进场」。
>
> 实际落地（2026-08-21）：三域各一轮 dogfood 全达成——whitebox：125 行埋雷项目 3 雷全中（SQLi/命令注入/路径穿越，均活体 PoC）+ 诱饵正确排除 + 额外中 2 个真问题（Content-Length DoS、无访问控制）；pentest：侦察（自装 nmap、6 端口、手工抓 banner）→ SQLi dump secrets → LFI 拿 flag 全链；ai-security：4 针间接注入探针 agent 全识别全拒（canary 零执行），复核更正了自动分级器的标记词误报。三域 `research_events` success 记录齐。skill 修正三处（小项目全读降级路径 / 裸机工具自装 + 手工 banner / 标记词判定要看上下文）+ **三域 skill 升 system（SYSTEM_SKILLS_VERSION 34→35）**——修正此前非 system 导致 seed-once 更新无法触达老安装的缺口。

---

## 1.1.7 —— 技术债版：IO 统一 + 引擎收拢 + god file 绞杀（已完成）

纯还债版，无用户可见功能。铁律：**纯搬移不改行为**——每个 commit 全量测试绿，测试断言一行不改。细节见 `docs/1.1.7-design.md`。

- [x] **① 文件 IO 纪律统一**——所有写 `~/.zhishi` 可变状态文件的点统一走 `withFileLock` + tmp+rename（范本：`environment/env-sessions.ts`）；首犯 `environment/selection.ts`（裸读写，1.1.6 核实时确认的活体坑）。读静态资源/bundled 的不动。验收：并发写不丢更新单测 + 全量回归绿。
- [x] **② 引擎状态收拢成类**——`chat-engine.ts` 的模块级 `let` 状态（sessionId/messages/queue/steering/busy/currentAbort/boundSessionMetaId/currentEnvKey/systemInitInfo 等）搬进 `ChatEngine` 类，24 个导出函数变方法；文件底部导出默认实例 + 原函数名 facade 委托，`admin-api.ts`/`index.ts` 调用点零改动。意义：可变状态边界显式化，2.0 多环境并行的地基（本步**不解** cron/TUI 语义耦合，只让耦合点可见）。验收：行为零变化，全量测试绿。
- [x] **③ god file 绞杀拆分（timebox：`index.ts` 13041 行 → ≤8000 行收手）**——主攻 `src/server/index.ts`：第一刀 cron（最内聚、与 1.1.6 耦合点最近）→ sessions 路由 → 路由表集中；每抽一块一个 commit。`admin-api.ts` 拆分优先级放低，本版不动。验收：行数达标 + 全量测试绿 + `npm run smoke` 5/5（VM 在线时）。

> 实际落地（2026-08-21）：① selection.ts 收编锁内读-改-写（并发写单测），其余候选甄别后不改（甄别清单见设计文档落地记录）；② 13 个状态字段收拢 + 20 个 facade，44 引擎用例零改动全绿；③ 四刀 13041→7660 行，顺手收编 writeSkillsConfig 锁（① 遗留项）。全量 1683 测试绿 + typecheck + eslint/depcruise 干净 + VM 在线 `npm run smoke` **5/5 全绿**。③ 剩余路由组（/api/agent/*、/chat/* 等）归日常随做随拆。

---

## 1.1.6 —— 会话分环境 + TUI 缺陷修复（已完成）

- [x] **修复 #2：`/env` 重新选择环境卡死**——根因已定位：`gateBusy` 成功路径不复位 + `enterGate()` 不重置（`app.ts:253/279/295`），二次进门所有键被吞。修复：`enterGate()` 入口复位 `gateBusy`；附带修复：重进 gate 按 Esc 应返回 chat 而非退出程序（区分 startup/reentry 来源）。验收：`/env` 打开列表可上下移动、Enter 选定生效、Esc 返回聊天界面。
- [x] **修复 #3：滚轮翻历史（已重新立项）**——原缺陷单已过时：鼠标捕获 2026-08-17 整体移除（`terminal-writer.ts:226-229`），滚轮当前无任何行为。实为「受控重新引入 wheel-only 捕获」：keymap 只放行 wheel 码 64/65（不开点击/拖拽，保住终端原生文本选择）。交互语义定案（方案 A）：任意态滚轮上滚 = 进入回看并翻历史，Esc 或滚到底回最新。验收：滚轮可翻历史，鼠标选择复制不受影响，Esc 回底正常。
- [x] **#4：会话按环境分线**——切换环境不重置、不串扰。映射结构 A1：独立映射文件 `env-sessions.json`（走 `withFileLock`），workspace × 环境键 → loopSessionId；`environment/select` 落盘后联动引擎切会话线（turn 运行中拒绝，提示先 Esc 中断）。已确认决策：①启动恢复改按「工作区 + 当前选定环境」接线（`restorePiSession` + `ensureAgentSession` 双处改造）；②`resetPiChat` 同步清对应映射，防旧历史复活；③映射键：env 按 envId、recipe 按 instanceId、host 单独一条线；④workspace 键统一规范化（防斜杠漂移裂线）；⑤cron 跟随当前选定环境的线，不特殊处理。验收：A/B 两环境各聊一段，来回切换各接各的历史，上下文不串场。

> 三项技术方案已核实定稿（2026-08-20），落地顺序：#2 → #3 → #4（#4 的联动入口依赖 #2 先修好）。根因分析与决策依据见 `docs/1.1.6-design.md`。
>
> 实际落地（2026-08-21）：三项全部实现；单测 1677 全绿 + typecheck + eslint/depcruise 干净。活体验收（`tmp/m6-env-lines.mjs`，host × pwn-vm 两线）：A/B 各聊一段来回切换各接各的历史（回放隔离正确）、映射双落盘、turn 运行中 select 拒绝、重启后续接当前环境线——全 PASS。VM 恢复后全量 `npm run smoke` 补跑 **5/5 全绿**（2026-08-21）；顺手修了 smoke 脚本三处陈旧/脆弱断言：m4b A1 队列断言适配 W1 steering 语义（1.0.0 起 busy 进 steering 队列，同 turn 注入响应只产一个 message-complete）、m4a 复跑前 reset（system-init 每条线只广播一次）、编排器套件间 10s pacing（防供应商限流）。

---

## 1.1.5 —— 多模型接入 + TUI 配置闭环（已完成）

- [x] **内置供应商端点扩充**：`PRESET_PROVIDERS` 增加 OpenAI 格式供应商——OpenAI、Moonshot/Kimi、通义 Qwen、智谱 GLM、硅基流动（聚合平台），每个带 baseUrl + `modelListUrl`（填 key 后自动拉模型列表）+ 内置常用模型清单。pi 层接 OpenAI completions 格式（pi-ai 已原生支持）。
- [x] **用户流程**：`zhishi model set-key <id> <key>` → 自动拉取模型列表 → 选模型 → `set-default`。真端点冒烟：OpenAI 格式 one-shot 真调用通过；服务端链路 curl 验证（model/list 8 家、set-key 拉列表、mcp enable/disable）通过。
- [x] **TUI 模型配置闭环**：`/model`（无参）状态卡（供应商/已配 key/当前默认/模型数）；`/model set-key <供应商id>` 隐藏输入填 key（终端 raw 模式不回显）→ 自动拉列表；`/model use <供应商id> <模型名>` 切换（带供应商前缀防重名）。
- [x] **MCP 开关进 TUI**：`/mcp enable <id>` / `disable <id>`（写盘 + 桥重载，当前会话生效）；add/remove 留 CLI（OAuth/多形态 spec 不适合 TUI 输入行）。

---

## 1.1.4 —— 情报体验 + 横切扩域（已完成）

- [x] **intel update 进度输出**：update 长回填时 CLI 端实时显示「已入库 N 条」（简单版，不做百分比估算——拉取前总量未知）。实现：sync 进度状态进 `intel/status`，CLI 轮询展示；同时加 update 并发互斥（第二个 update 返回「已有更新在跑」）。实跑验证通过（0→869 条实时刷新）。
- [x] **情报横切扩 pentest 域**：nuclei 模板清单索引（**只存目录不存正文**——与 exploit-db 同原则，模板内容给 GitHub 链接）。新表 `nuclei_templates`（cve_id/template_path）+ 同步进 `zhishi intel update`（**多源 fallback**：raw → jsdelivr → api.github.com contents，本机网络实测前两者 node 不可达）+ `--nuclei-file` 本地导入兜底 + `intel_search` 扩展「查 CVE 的现成检测模板」（**只做 CVE→模板这一个查询维度**）。实跑验证通过（4321 条入库，CVE-2021-44228/2023-23752/2024-3400 联查正确）。

---

## 1.1.1 —— 能力补齐：扩展面收敛（已完成）

- [x] **TUI 接入面补完（MCP / 插件）**：原规划「TUI 只接了 skills，MCP / 插件在 CLI 已可用，TUI 侧入口与状态展示待补」。
  实际落地（2026-08-19）：
  - MCP 工具接入引擎（`mcp__<server>__<tool>` 命名、启动即连接、单点失败不阻塞会话）+ `mcp/reload` 热重载（配置以磁盘为准）+ TUI `/mcp` 状态与刷新——配置后工具在会话可用
  - .zsp 加密插件体系整体移除（商业分发时代残留，与开源定位冲突）——扩展统一由 MCP + skills 承担

## 1.1.2 —— 情报横切最小落地（已完成）

- [x] 每个研究域的侦察阶段接一条情报通道——给引擎一个宿主侧情报检索工具（NVD / exploit-db），先接二进制域。
  实际落地（2026-08-19）：`intel.db` 本地索引（分级 minimal/window/full + maxSizeMb 自裁）+ `zhishi intel update/status`（NVD 增量/断点续传/重试，exploit-db CSV 去重）+ loop 工具 `intel_search`（FTS 检索/在线回源/结果截断）。
  验收达成：真实会话中情报被消费；实跑 window 档 15.7 万 CVE + 4.7 万 exploit。

---

## 1.1.3 —— 引擎深化（已完成）

- [x] **后台长驻进程稳定性闭环**：登记表落盘（重启恢复）+ poll 存活探测（.pid 一致性校验）+ turn 结束/reset 回收杀掉（暂定决策，替代方向「保留续跑+认领」见 `bg-reap.ts` 底稿）。活体验证中修复回收组杀（setsid 建组），二次验证进程无残留。
- [x] **经验反喂效果验收**：度量口径先行（`docs/distill-eval.md`——重复踩坑率/回合数，每域 ≥10 组可比任务）；当前 3 条样本，量化暂缓等数据。
- [x] **引擎底座升级回归**：`npm run smoke` 一键回归（m1→m3 活体全绿，任一失败 exit 1 阻断升级；SDK 对照脚本除名）。

---

## 未排版本

（原「各域 skills 实战深化」已收编进 1.1.8）

## 后续候选（未定版本）

- 2.0 方向：多环境并行（单环境 → 跨 VM/靶机协同）、研究记录可导出/分享、红队与恶意软件域重启评估（暂缓项）
- 发行链路：Windows 安装包 + 便携 ZIP 首发、macOS 构建冒烟、安装包自动更新链路真机验证
