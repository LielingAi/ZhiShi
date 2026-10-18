# ZhiShi — 安全研究 Harness

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo.png" alt="zhishi 执失" width="96">
  </picture>
</p>

**v2.0.2 · 安全研究领域的 agent harness：多环境协同、原生语义查询、环境融合、研究档案。**

[![Version](https://img.shields.io/github/v/tag/LielingAi/ZhiShi)](https://github.com/LielingAi/ZhiShi/tags)
[![License](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010+-blue.svg)]()
[![Node](https://img.shields.io/badge/Node-%3E%3D22-green.svg)]()
[![Homepage](https://img.shields.io/badge/Homepage-zhishi.help-blue)](https://zhishi.help)

> 📖 **新用户从这里开始：[使用指南](docs/user-guide.md)** —— 安装、选环境、配模型、GUI 操作、常见问题。
> 📦 **Windows 安装包：[GitHub Releases 下载最新版](https://github.com/LielingAi/ZhiShi/releases/latest)**（NSIS 安装包 / 便携 ZIP）。

> 以实战出发的**漏洞研究专用 harness**。

> **免责声明**：本工具仅面向**合法授权**的安全研究（漏洞挖掘、复现、渗透测试）。禁止对未授权目标使用；使用者须遵守当地法律法规，作者不承担任何非法使用产生的后果。

---

## 实战成果

CTF 通关明细（部分知名平台）：

| [Pwnable.kr](https://pwnable.kr) | [Hacker101 CTF](https://ctf.hacker101.com) | [HackThisSite](https://www.hackthissite.org) | [ROP Emporium](https://ropemporium.com) | [VulnHub](https://www.vulnhub.com) |
|---|---|---|---|---|
| 100% | 98% | 96% | 91% | 90% |

### 完整复现

> 🔴 **[CVE-2026-34621](https://www.cve.org/CVERecord?id=CVE-2026-34621) · Adobe Acrobat Reader — 原型污染（CVSS 8.6）**
> 从触发条件到武器化的完整利用链复现。

### 提报 CVE

| CVE | 目标 | CVSS |
|---|---|---|
| CVE-2026-66319 | Microsoft | 待公开 |
| [CVE-2026-0961](https://www.cve.org/CVERecord?id=CVE-2026-0961) | Wireshark · BLF 文件解析崩溃 DoS | 5.5 |
| [CVE-2025-1162](https://www.cve.org/CVERecord?id=CVE-2025-1162) | Job Recruitment 1.0 | 5.3 |
| [CVE-2025-1171](https://www.cve.org/CVERecord?id=CVE-2025-1171) | Real Estate Property Management System 1.0 | 5.1 |
| [CVE-2025-1170](https://www.cve.org/CVERecord?id=CVE-2025-1170) | Real Estate Property Management System 1.0 | 5.1 |
| [CVE-2025-1163](https://www.cve.org/CVERecord?id=CVE-2025-1163) | Vehicle Parking Management System 1.0 | 4.8 |
| [CVE-2025-1164](https://www.cve.org/CVERecord?id=CVE-2025-1164) | Police FIR Record Management System 1.0 | 4.8 |

### 在途

- **7 个漏洞**在微软审核流程中
- 白盒审计挖掘了 200+ 漏洞，部分漏洞正在提报 CVE

### 浏览器漏洞

- 多个 Chrome / Firefox 漏洞分析与复现

---

## 它是什么

ZhiShi 是给安全研究员的工作台：二进制利用、渗透测试、白盒审计、AI 安全四个研究方向。

| 支柱 | 含义 |
|---|---|
| **环境融合** | 环境归 agent 管——建、跑、快照、回滚。底座：Docker / VMware / Hyper-V / VirtualBox / SSH 靶机。 |
| **多环境协同**（2.0） | **每个环境做不同的事**：fuzz 环境盲跑、pwn 环境复现、audit 环境审计同时进行。一个环境面板看全在干什么、干完没有；切换永不被拒。 |
| **原生工具** | 工具都在环境里。发现、调用、验证——不打包工具，只做协作面。 |
| **原生语义查询**（1.9.10） | `code_query`：环境内 joern CPG 语义查询——"memcpy 且 len 来自报文字段"一语句命中，超大项目不再靠 grep 撞大运。 |
| **原生代码** | 以安全研究为核心的代码能力——exp、shellcode、fuzz harness，写了就编译，崩了就改。 |

一次真实研究会话长这样：

```
环境 pwn-vm（vm） · 能力：binary · pentest

❯ 分析 /home/researcher/ret2win/vuln，gets 溢出，打通拿 flag

⏺ env_exec(checksec ./vuln)
   Stack: No canary · PIE: No · win @ 0x401196
⏺ env_exec(python3 exp.py)
   exit=0

⏺ 偏移 72（cyclic + core 确认），垫 ret gadget 对齐 movaps，
   跳 win 拿到 flag{ret2win_pwned_successfully}
```

## 2.0 有什么新东西

### 多环境：环境 = 场地，线 = 活

- **环境面板**：底栏单入口点开——一行一环境：全名 / 状态 / **在干什么**（auto loop 任务名 + 状态）/ **最近完成**；点行即切。auto-run 收口时不管在哪个环境都会收到回执
- **注视语义**：忙碌环境切过去 = **只读查看**（PeekView），原线照跑、Esc 回无损——切换永不被拒
- **跨环境直达** `/xfer 源环境:路径 目标环境:路径`：docker cp / vmrun / scp 全 kind 一条命令
- **台账治理**：同名环境合并（双守卫 + 线映射迁移）、僵尸清理、auto-run 派活到任意环境
- **术语统一**：工作线程统一叫**线**；档案里的假设→证据→结论链条叫**假设链**

### GUI 操作系统骨架

- **正门**：全幅启动台——环境卡片横铺、同名台账条、清理入口；有环境时启动直接回昨天现场
- **三列骨架**：menubar（当前线 / 任务形态 / 系统计量）· 会话流（唯一主角）· 检查面板四页签（任务 / 线 / 档案 / 检查器）
- **命令中枢 Ctrl+K**：动词目录（`/resume` `/kill` `/mission` `/use` `/xfer`…）+ 最近历史 + 对象补全；与输入行 `/` 同引擎
- **回执双轨**：成功动作状态行 ✓（不外弹），错误/进行中才弹 toast
- **Markdown 消息渲染**：标题/列表/代码块/表格/任务列表仪器感定制；日志报错维持原文不错杀
- **WebView2 缓存根治**：版本化数据目录——升级后必然看到新界面

## 核心特性

### 控制面：GUI 主窗口（1.3.9 起 TUI 退役，2.0 骨架定型）

![正门启动台：环境卡片横铺 + 台账合并条 + 右侧检查面板](assets/gui.png)

- 正门选/建环境（docker 配方 / VM 配方 / 接入已有 / 手动 SSH）+ 本机发现登记/去重 + 台账治理
- 块化会话流（输入=块首、结论聚合亮顶、thought/工具卡折叠、抽屉详情）+ 运行中输入即纠偏
- 检查面板四页签：任务（战役对象卡：FSM 轨道/墙钟预算/信号流）· 线（分线清单/共享/切线）· 档案（假设链看板）· 检查器（崩溃件 + 一键挂证据到档案）
- 环境准入闸（已停止不可进入，先启动）+ 三态判定统一
- 决策面板（模型方向分歧提请人拍板 + 专家依据区 + 决策块落流可追溯）
- **研究档案**（假设/证据/结论/未决问题随研究实时生长，行内纠正，档案锚↔流双向互跳；结论必须有证据支撑——finding 强制挂 V# 证据引用，证伪走 falsify/correct 留痕）
- **auto loop agent**（目标式研究循环：启动表单任选环境/目标/预算/验收条件，运行期只观察，验收包人终审，达成自动出报告；**CLI 策略模式**——策略 YAML 唯一治理源，无人值守全程自主）
- **历史线**（线清单/搜索/只读回看/载回续跑/重命名/置顶/归档/删除）
- attach 真终端（xterm + WS pty：docker exec -it / ssh -tt）+ 一次性命令执行双模式
- 越界动作模态（写宿主等四类，逐次问人，无「永远允许」）+ 后台任务状态栏可见（`⛁ fuzz · 跑着`）
- 桌面图标/托盘/二次实例 → 聚焦 GUI 主窗口（自启静默不弹窗）

### 团队协作：团队大脑（1.8.7）

一个团队大脑（服务器上唯一的 sidecar）+ 远端客户端（应用 / CLI）——线、档案、claims、知识、蒸馏、环境全部集中在服务器上；成员机器上只保留宿主 shell 与自己的文件。

- **客户端远端模式**：CLI `zhishi --server http://host:port --token …`（或 `ZHISHI_SERVER`/`ZHISHI_TOKEN`）；GUI 设置 → 连接（本机 / 团队大脑，地址 + token）
- **大脑**：`--host <内网地址>` 起 sidecar + `zhishi auth add/enable` 发 token（只存 SHA-256 哈希）；非回环地址未启用鉴权**拒绝启动**；角色三档（只读 / 操作员 / 审定人），100+ 路由逐条分类
- **双线制**：私有线默认（owner 读写），共享线显式开（`zhishi line share/unshare <id>`）；多条线可同时跑 turn 互不阻塞（多引擎，空闲回收不丢历史）；SSE 按线分流
- **身份贯穿**：档案纠正 / 专家审定 / claims / 研究留痕 / boundary 应答全部署名到具体的人
- **文件传输**：`zhishi env put-file / get-file`——成员笔记本 ↔ 服务器环境端到端（sha256 校验）
- **模式角标**：状态栏常驻「本机 / 团队大脑 · host / 连接失败」——当前操作落在哪个大脑上一眼可见
- **传输约束（实证）**：成员 GUI 不能直接填 `http://<服务器IP>`（Chrome 混合内容拦截）——用 SSH 隧道或 HTTPS

### 引擎：自研 loop（harness 本体）

| 面 | 内容 |
|---|---|
| 工具 | `env_exec`（一次性）· `env_bg`（后台长驻：start/poll/log/kill/list）· `code_query`（环境内 CPG 语义查询：数据流/调用图/结构定位）· `delegate_task`（子任务，按名派发专用 agent）· `research_log`（研究留痕）· `research_archive`（研究档案：假设/证据/结论/未决问题 + 证伪/纠正）· `request_decision`（方向分歧提请人拍板）· `declare_completion`（auto loop 达成声明） |
| 边界 | 规则硬闸（工具白名单 / 环境就绪 / 凭据不泄进环境）+ 输出净化 + 越界问人通道 |
| 上下文 | 工作记忆窗口置换（预算 0.25×窗口、指针块 + recall 取回——1.18M 上下文稳态与看门狗误杀实机根治）+ Claim 治理（Event→Claim 提取/去重/冲突收敛/双时间/遗忘）+ 自动检索注入 |
| 记忆闭环 | research_events → 按研究域蒸馏（经验不跨域，置信度 0.xx 分级）→ 逐 turn 反喂系统提示 |
| 研究档案 | 研究 = 过程 + 成果：实体三要素（来源锚 + 状态 + 链接）全程举证、可推论/反推论/可纠正；每轮注回模型上下文；报告从同一档案派生（成果章节带证据锚、证伪与纠正独立成节） |
| auto loop | 目标式研究循环：**策略治理**——策略 YAML 唯一治理源、全自主无人值守、同 envKey 互斥闸；GUI 交互模式保留（预算三选一、验收包人终审）。2.0：环境任选 + 终态全局回执 |
| 认知内核 | 第一性原理五层认知（深度理解 → 对抗共情 → 溯因推理 → 认识论谦卑 → 远距类比）+ 置信度校准锚点（< 0.60 不报告）+ 硬排除清单 |
| 专家知识 | `expert.db`——判据化的权威知识层（SOP/判定链/方法论，人审定才进库）：harness 邻域注入（档案焦点 + 最近消息为锚自动检索）、`expert_search` 检索兜底、留痕可挂 `expert_refs`；现成 JSON/YAML 直接 `zhishi expert import` 批量入库 |
| 研究报告 | `/export` 一键出报告目录（report.md + evidence/ PoC 本体）：骨架事实钉死 + LLM 填肉、按域模板、显式脱敏可选 |
| 工具侧技能 | 4 个工具本体随包分发（agent-browser / download-anything / zhishi-cli / range-ops——发现 + .claude 兼容同步） |
| 子代理 | bundled-agents：fuzz-runner / crash-triager / vuln-hunter / hypothesis-tester / critic；`/tasks` 面板看工作现场与完整 transcript |
| 域包 | `bundled-domains/<域>/domain.json` —— 域 = 研究知识维度，只由任务内容判定（配方默认 + 内容信号动态修正）；`zhishi domain check` 就绪自检 |
| 模型 | 8 家内置供应商端点（kimi / deepseek / openai / moonshot / 通义 / 智谱 / 硅基流动…），`zhishi model set-key <id> <key>` 后自动拉模型列表，GUI 状态栏切换（只显示已配置供应商） |

## 快速开始

> 发行版（推荐）：[GitHub Releases](https://github.com/LielingAi/ZhiShi/releases/latest) 下载 Windows 安装包/便携 ZIP → 安装 → 点击图标即开 GUI 主窗口（后台宿主管理 sidecar 生命周期）。要求 Node.js ≥ 22（安装包已内置）。

开发态直跑源码：

```bash
npm install

# 一条命令：Tauri 开发壳（GUI 窗口 + sidecar + vite HMR）
npm run tauri:dev

# 或分开跑——终端 1：sidecar（引擎 + admin API）
node --import tsx/esm src/server/index.ts --agent-dir "$PWD"

# 终端 2：GUI（vite dev server，浏览器/窗口连 sidecar）
npm run dev:gui
```

GUI 打开即**正门**：选环境（没有就从向导新建），之后一切研究都在环境内进行。工作区里 `Ctrl+K` 是命令中枢，底栏环境 chip 点开即多环境面板。

### 环境管理

```bash
zhishi env recipes                    # 内置环境类型：dev / pwn / fuzz / rev / code-audit / pentest / ai-security + VM 变体
zhishi env up pwn-vm                  # 从环境类型建环境
zhishi env adopt pwn-vm --vm <vmx> --user <用户>   # 纳管已有 VM
zhishi env list
zhishi env ps
```

### 模型配置

```bash
zhishi model list
zhishi model set-key deepseek <apiKey>
zhishi model verify deepseek
zhishi model set-default deepseek
```

### auto loop（无人值守研究循环）

```bash
zhishi auto-run start --name "hacknote 复现" \
  --goal "复现 hacknote uaf 拿到 shell" --env-key pwn-vm \
  --criteria "拿到 flag" --criteria "PoC 稳定复现 3 次" \
  --budget-kind turns --budget-limit 30 \
  --policy-file examples/auto-run/balanced.yaml   # 缺省 = 内置保守档

zhishi auto-run list      # 状态 + 报告路径
```

策略 YAML 文档 `docs/auto-run-policy.md`；CLI 用法 `docs/auto-run-cli.md`；示例三档 `examples/auto-run/`。

### CLI 自立 + 一机多 run

**无 GUI 跑**：`zhishi auto-run` 在服务器/计划任务里脱离 GUI 使用——首条命令自动拉起本地 sidecar（探测 + `/health`，活着就复用）。

**一机多 run**：同一 sidecar 并行跑多条 auto-run（批跑常态）——各 run 独立线/记录/事件；唯一互斥是**同 envKey**（执行现场互斥）。要并行，每条 run 绑不同环境。容量瓶颈依次是 provider 并发配额、WSL2 内存、CPU 核数——i5-9300H/40GB 舒服并行 3–4 条。

### 专家知识与域包

> 专家知识仓库：[ZhiShiExpertKnowledge](https://github.com/LielingAi/ZhiShiExpertKnowledge)——社区共享的判据化专家条目，下载后 `zhishi expert import` 即可入库。

```bash
zhishi expert list             # 专家库清单
zhishi expert search "栈溢出"   # 检索专家知识
zhishi expert import <file>    # JSON/YAML 批量入库
zhishi domain list             # 域包清单
zhishi domain check binary     # 就绪自检
```

## 编译与运行

### 编译（Node 侧产物，esbuild 打包）

```bash
npm run build:server        # sidecar → src-tauri/resources/server-dist.js（ESM）
npm run build:cli           # CLI → src-tauri/resources/cli/zhishi.js + zhishi.cmd
npm run build:tsx-runtime   # 插件 TS 转译运行时 → src-tauri/resources/tsx-runtime/
npm run sync:bundled-skills # 内置 skills 同步
```

### 发行包（Windows：NSIS 安装包 + 便携 ZIP）

```bash
npm run tauri:build   # 或 scripts/build/build_windows.ps1（完整发布流程）
```

产物在 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`。安装后：Tauri 壳负责 GUI 窗口 + sidecar 生命周期与自更新，`zhishi` 命令同步到 `~/.zhishi/bin/`。构建细节见 `docs/spec/windows-release-build.md`。

## 架构

```mermaid
flowchart LR
    U[研究员] <-->|GUI 主窗口| G[GUI webview<br/>React + SSE]
    G <-->|HTTP + SSE + WS| S[Sidecar]
    S --> L[自研 loop 引擎]
    L --> M[LLM 供应商<br/>kimi / deepseek / …]
    L -->|env_exec / env_bg| E1[Docker 环境]
    L -->|env_exec / env_bg| E2[VM 环境<br/>VMware / Hyper-V / VirtualBox]
    L -->|env_exec / env_bg| E3[SSH 靶机]
    L -->|code_query| J[joern CPG<br/>语义查询]
    L --> DB[(research_events<br/>记忆蒸馏 + 研究档案)]
    S --> CFG[(config.json · env-sessions.json · loop-sessions)]
```

| 模块 | 位置 |
|---|---|
| 引擎（loop / 工具 / 边界 / 蒸馏 / code_query） | `src/server/loop/`、`src/server/memory/` |
| 环境层（探测 / 生命周期 / 纳管 / 台账 / 传输） | `src/server/environment/` |
| admin API（sidecar HTTP 面） | `src/server/admin-api.ts`、`src/server/index.ts` |
| GUI（React + zustand + xterm；正门/会话流/检查面板/环境面板） | `src/gui/` |
| CLI 统一入口（model/env/expert/term/auto-run/line/…） | `src/cli/zhishi.ts` |
| 内置环境类型 / 工具侧技能 / 域包 / 子代理 / 专家条目 | `bundled-environments/`、`bundled-skills/`、`bundled-domains/`、`bundled-agents/`、`bundled-expert/` |

## 验证状态

| 项 | 状态 |
|---|---|
| 单元测试 | **2853 全绿（2.0.0）**；`tsc --noEmit` / `eslint` 零错 / depcruise 架构边界强制；Rust `cargo test` 184 + clippy 零警告 |
| 活体回归 | `npm run smoke` 一键（真端点 + 真 VM，m1-m4 全链路）；产物级 smoke（打包产物跑关键路径） |
| 活体 dogfood | ret2win 全程打通；三域实战验证（whitebox 埋雷审计全中 / pentest 全链拿 flag / ai-security 注入探针全拒）；cJSON 四轮 dogfood 实证 |
| code_query E2E | joern 4.0.656 真链路三问重放全绿（净荷 9.5KB/9.5KB/2.4KB，时延 ~8s）+ 六处版本兼容钉正 |
| 多环境（2.0）实机 | 六轮真机迭代验收：环境面板 / 注视语义 / 台账合并与清理 / 跨环境 xfer / 术语统一 / 切线修复 |
| 域内容件 | 四域齐备（binary / pentest / whitebox / ai-security）并经实战验证 |

## 文档

| 文档 | 内容 |
|---|---|
| `docs/roadmap.md` | 版本任务池（当前线：**2.0.x——多环境**；历史大版本见文件内台账） |
| `docs/user-guide.md` | 使用指南（安装、选环境、配模型、GUI 操作、常见问题） |
| `docs/design/multi-env-design.md` | 2.0 多环境设计稿（多环境可用/单环境专注；注视语义/xfer/台账） |
| `docs/design/gui-v4-skeleton-design.md` | GUI 操作系统骨架设计稿（正门/三列/命令中枢/回执） |
| `docs/design/gui-v4-capability-audit.md` | GUI 业务能力审查清单（9 域 74 项不丢项底账） |
| `docs/design/code-search-design.md` | code_query 语义查询设计稿（joern/CPG 工具化 + E2E 判据） |
| `docs/auto-run-policy.md` | auto loop 策略 YAML 文档（schema / 逐节语义 / 校验规则） |
| `docs/auto-run-cli.md` | auto loop 命令行用法（命令 / 旗标 / 脚本模式 / 退出码） |
| `examples/auto-run/` | 策略示例三档（conservative / balanced / full-auto） |
| `docs/expert-import-guide.md` | 专家知识导入指南；社区条目仓库：[ZhiShiExpertKnowledge](https://github.com/LielingAi/ZhiShiExpertKnowledge) |
| `docs/design/` | 各版本设计与分析稿 |
| `docs/spec/` | 长期契约与专项设计（产品设计 D1–D31、技术方案、交互契约、发行清单等） |
| `docs/design/discovery-campaign.md` | 战役原语设计稿（发现式搜索的状态机与信号源） |
| `CLAUDE.md` | 开发红线与命令（开发前先读） |

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint + depcruise
npm run test:unit    # vitest 单测
npm run test         # 全量测试
```

提交遵循 Conventional Commits；不提交敏感信息。

## 致谢

zhishi 的 loop 引擎以 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-agent-core`，MIT）为底座——感谢 pi 提供传输抽象、状态管理与附件支持等通用能力，安全研究定制层建立在它之上。

---

喜欢 zhishi？[点个 star](https://github.com/LielingAi/ZhiShi/stargazers)，让研究被看见。有发现就开 issue，想动手，欢迎 PR。

## License

[AGPL-3.0](LICENSE)
