# ZhiShi — 安全研究 Harness

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo.png" alt="zhishi 执失" width="96">
  </picture>
</p>

**v1.2.7 · 安全研究领域的 agent harness：环境融合、原生工具、原生代码。**

[![Version](https://img.shields.io/github/v/tag/LielingAi/ZhiShi)](https://github.com/LielingAi/ZhiShi/tags)
[![License](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010+-blue.svg)]()
[![Node](https://img.shields.io/badge/Node-%3E%3D22-green.svg)]()
[![Homepage](https://img.shields.io/badge/Homepage-zhishi.help-blue)](https://zhishi.help)

> 📖 **新用户从这里开始：[使用指南](docs/user-guide.md)** —— 安装、选环境、配模型、TUI 命令大全、常见问题。
> 📦 **Windows 安装包：[GitHub Releases 下载最新版](https://github.com/LielingAi/ZhiShi/releases/latest)**（NSIS 安装包 / 便携 ZIP）。

![TUI 会话界面](assets/tui-session.png)

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
| **原生工具** | 工具都在环境里。发现、调用、验证——不打包工具，只做协作面。 |
| **原生代码** | 以安全研究为核心的代码能力——exp、shellcode、fuzz harness，写了就编译，崩了就改。 |

一次真实研究会话长这样：

```
ZhiShi 安全研究台
  环境 pwn-vm（vm）
  输入开始工作 · / 命令 · @ 引用 · Ctrl+L 帮助

❯ 分析 /home/researcher/ret2win/vuln，gets 溢出，打通拿 flag

⏺ env_exec(checksec ./vuln)
   Stack: No canary · PIE: No · win @ 0x401196
⏺ env_exec(python3 exp.py)
   exit=0

⏺ 偏移 72（cyclic + core 确认），垫 ret gadget 对齐 movaps，
   跳 win 拿到 flag{ret2win_pwned_successfully}
```

一次 CTF 实战的完整链路（命令执行绕过 → 任意命令构造 → 环境侦察 → 凭据泄露 → 数据库取 flag）：

![CTF 实战：PHP 黑名单绕过到拿到 flag 的完整链路](assets/ctf-flag-run.png)

## 核心特性

### 控制面：全屏 TUI

![正门：选择本次会话的工作环境](assets/tui-env-gate.png)

- 正门强制选环境（无 host 模式），`--env <id>` / `--new-env <类型>` 直通
- 流式会话 + 工具卡折叠（只留关键信号：exit 码、崩溃、flag、CVE、端口、会话已开）
- 会话按环境分线（每环境独立历史，来回切换各接各的，不串场）
- 中断五档：`Esc` 停止 · 运行中输入即纠偏 · `Ctrl+Z` 回思路（rewind）· `/rollback` 回环境 · `/attach` 接管环境 shell
- 回看：PgUp/PgDn 整页 + 滚轮逐行 + Ctrl+Home 跳顶，输入永不锁；Esc 清草稿可恢复
- `/` 命令面板、`@` 引用、`Ctrl+R` 历史搜索、`Ctrl+L` 帮助、`/fork` 分叉线程、`/tasks` 子任务面板
- 越界动作红色模态（写宿主等四类，逐次问人，无「永远允许」）
- 后台长驻进程状态行可见（`⛁ fuzz · 跑着`）+ 退出插行
- 桌面图标点击即开 TUI（安装包形态；自启静默不弹窗）

### 引擎：自研 loop（harness 本体）

| 面 | 内容 |
|---|---|
| 工具 | `env_exec`（一次性）· `env_bg`（后台长驻：start/poll/log/kill/list）· `delegate_task`（子任务，按名派发专用 agent）· `research_log`（研究留痕） |
| 边界 | 规则硬闸（工具白名单 / 环境就绪 / 凭据不泄进环境）+ 输出净化 + 越界问人通道 |
| 上下文 | 安全定制压缩：死路（非零 exit）与突破口（flag/CVE）永不裁 |
| 记忆闭环 | research_events → 按研究域蒸馏（经验不跨域，置信度 0.xx 分级）→ 逐 turn 反喂系统提示 |
| 认知内核 | 第一性原理五层认知（深度理解 → 对抗共情 → 溯因推理 → 认识论谦卑 → 远距类比）+ 置信度校准锚点（< 0.60 不报告）+ 硬排除清单 |
| 专家知识 | `expert.db`——权威知识层（思路/技术/SOP，人审定才进库）：卡住了 LLM 无把握时的最后落脚点，`expert_search` 检索；留痕可挂 `expert_refs` 追溯「决策依据 E#N」 |
| 研究报告 | `/export` 一键出报告目录（report.md + evidence/ PoC 本体）：骨架事实钉死 + LLM 填肉、按域模板、敏感项清单知情、显式脱敏可选 |
| 能力包 | skills 提示词注入（binary-exploit / vuln-triage / native-code-loop / range-ops / pentest / whitebox-audit / ai-security + 用户库 `~/.zhishi/skills/`） |
| 子代理 | bundled-agents：fuzz-runner / crash-triager / vuln-hunter / hypothesis-tester / critic；`/tasks` 面板看工作现场与完整 transcript |
| 域包 | `bundled-domains/<域>/domain.json` —— 环境类型 / skill / 子代理 / 信号 / 验收一键声明，`zhishi domain check` 就绪自检 |
| 模型 | 8 家内置供应商端点（kimi / deepseek / openai / moonshot / 通义 / 智谱 / 硅基流动…），`zhishi model set-key <id> <key>` 后自动拉模型列表，TUI `/model` 闭环 |

## 快速开始

> 发行版（推荐）：[GitHub Releases](https://github.com/LielingAi/ZhiShi/releases/latest) 下载 Windows 安装包/便携 ZIP → 安装 → 点击图标即开 TUI（无窗口后台宿主 + 终端会话）。要求 Node.js ≥ 22（安装包已内置）。

开发态直跑源码：

```bash
npm install

# 终端 1：sidecar（引擎 + admin API）
node --import tsx/esm src/server/index.ts --agent-dir "$PWD"

# 终端 2：TUI（Windows 先 set，POSIX 用 export）
set ZHISHI_PORT=3000
node --import tsx/esm src/cli/zhishi.ts agent
```

TUI 启动即进正门：选择本次会话的工作环境（没有环境就从环境类型新建一个），之后一切研究都在环境内进行。

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

### Skills 与域包

```bash
zhishi skill list              # 用户库
zhishi skill disable docx      # 禁用（内置同名也生效）
zhishi domain list             # 域包清单
zhishi domain check binary     # 就绪自检（引用完整 + 工具漂移 + 验收清单）
```

## 编译与运行

### 编译（Node 侧产物，esbuild 打包）

```bash
npm run build:server        # sidecar → src-tauri/resources/server-dist.js（ESM）
npm run build:cli           # CLI → src-tauri/resources/cli/zhishi.js + zhishi.cmd（ESM + shebang）
npm run build:tsx-runtime   # 插件 TS 转译运行时 → src-tauri/resources/tsx-runtime/
npm run sync:bundled-skills # 内置 skills 同步
```

### 编译后运行（不经 Tauri 壳）

```bash
# 终端 1：sidecar（编译产物，与开发态 tsx 启动等价）
node src-tauri/resources/server-dist.js --agent-dir "$PWD"

# 终端 2：TUI（编译产物 CLI；Windows 先 set ZHISHI_PORT=3000，POSIX 用 export）
node src-tauri/resources/cli/zhishi.js agent
```

### 发行包（Windows：NSIS 安装包 + 便携 ZIP）

```bash
npm run tauri:build   # 或 scripts/build/build_windows.ps1（完整发布流程）
```

产物在 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`。安装后：Tauri 壳（无窗口）负责 sidecar 生命周期与自更新，`zhishi` 命令同步到 `~/.zhishi/bin/`。构建细节与验证清单见 `docs/windows-release-build.md`。

## 架构

```mermaid
flowchart LR
    U[研究员] <-->|全屏 TUI| TUI[zhishi agent]
    TUI <-->|HTTP + SSE| S[Sidecar]
    S --> L[自研 loop 引擎]
    L --> M[LLM 供应商<br/>kimi / deepseek / …]
    L -->|env_exec / env_bg| E1[Docker 环境]
    L -->|env_exec / env_bg| E2[VM 环境<br/>VMware / Hyper-V / VirtualBox]
    L -->|env_exec / env_bg| E3[SSH 靶机]
    L --> DB[(research_events<br/>记忆蒸馏)]
    S --> CFG[(config.json · env-selection.json · loop-sessions)]
```

| 模块 | 位置 |
|---|---|
| 引擎（loop / 工具 / 边界 / 蒸馏） | `src/server/loop/`、`src/server/memory/` |
| 环境层（引擎探测 / 环境类型 / 生命周期 / 纳管） | `src/server/environment/` |
| admin API（sidecar HTTP 面） | `src/server/admin-api.ts`、`src/server/index.ts` |
| 全屏 TUI（reducer / 渲染 / 正门 / 命令） | `src/cli/tui/v2/` |
| CLI 统一入口 | `src/cli/zhishi.ts` |
| 内置环境类型 / 技能 / 域包 / 子代理 | `bundled-environments/`、`bundled-skills/`、`bundled-domains/`、`bundled-agents/` |

## 验证状态

| 项 | 状态 |
|---|---|
| 单元测试 | 1900+ 全绿；`tsc --noEmit` / `eslint` 零错 / depcruise 架构边界强制 |
| 活体回归 | `npm run smoke` 一键（真端点 + 真 VM，m1-m4 全链路）；产物级 smoke（打包产物跑关键路径） |
| 活体 dogfood | ret2win 全程打通；1.1.8 三域实战验证（whitebox 埋雷审计全中 / pentest 全链拿 flag / ai-security 注入探针全拒），详见 `docs/` |
| TUI 全链路真机 | 选环境 / 流式 / 中断 / 回退 / 快照回滚 / 接管 / 后台任务 / 越界模态 / fork 全部通过 |
| 域内容件 | 四域齐备（binary / pentest / whitebox / ai-security）并经实战验证 |

## 文档

| 文档 | 内容 |
|---|---|
| `docs/roadmap.md` | 版本任务池（当前线：1.2.x 校准协作——研究交付 + 专家知识层） |
| `docs/expert-knowledge-plan.md` | 专家知识层迭代与技术方案（1.2.1-1.2.3） |
| `docs/security_researcher_agent_design.md` | 产品设计（决策记录 D1–D31） |
| `docs/security_researcher_agent_tech_plan.md` | 技术方案 |
| `docs/tui_tech_spec.md` / `docs/tui-rebuild-plan.md` | TUI 契约与重建蓝图 |
| `docs/env-bg-design.md` | 环境内长驻进程通道设计底账 |
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
