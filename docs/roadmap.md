# Roadmap

> 版本任务池。1.0.0 = 安全研究员版定型（已完成）；当前线：1.1.x（能力补齐 + 引擎深化）。
> 状态约定：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。任务细节不写在这里——细节进对应设计文档。

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

- [ ] **各域 skills 实战深化**：binary 域最强（ret2win 验证过）；pentest / whitebox / ai-security 的 skills 属「声明齐、实战未验证」——每个域至少一次真实任务跑通，按结果修正对应 skill。验收：三域各一条 dogfood 成功记录落 `research_events`。（暂缓：文档性质工作，功能层面优先）

## 后续候选（未定版本）

- 2.0 方向：多环境并行（单环境 → 跨 VM/靶机协同）、研究记录可导出/分享、红队与恶意软件域重启评估（暂缓项）
- 发行链路：Windows 安装包 + 便携 ZIP 首发、macOS 构建冒烟、安装包自动更新链路真机验证
