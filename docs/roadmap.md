# Roadmap

> 版本任务池。1.0.0 = 安全研究员版定型（已完成）；当前线：1.1.x（能力补齐 + 引擎深化）。
> 状态约定：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成。任务细节不写在这里——细节进对应设计文档。

---

## 1.1.6 —— 会话分环境 + TUI 缺陷修复（进行中）

- [ ] **修复 #2：`/env` 重新选择环境卡死**——选择列表无法上下移动、无法选定，正门选择流程功能性损坏。验收：`/env` 打开列表可上下移动、Enter 选定生效、Esc 取消正常。
- [ ] **修复 #3：鼠标滚轮随处翻历史**——滚轮应只在回看模式（Paging 状态）翻历史，正常输入态滚动不应触发。验收：输入态滚轮不翻历史，回看态翻页正常。
- [ ] **#4：会话按环境分线**——切换环境不重置、不串扰。每个环境独立会话线（映射结构 A1：独立映射文件 `env-sessions.json`，workspace × envId → loopSessionId）；`environment/select` 落盘后联动引擎切会话线（turn 运行中拒绝切换，提示先 Esc 中断）；启动恢复按「工作区 + 当前选定环境」接对应线。验收：A/B 两环境各聊一段，来回切换各接各的历史，上下文不串场。

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
