# 安全研究员专属智能体 —— 技术方案（对照 ZhiShi 代码库）

> 状态：**定稿**（2026-08-15）。上游文档：`docs/security_researcher_product_plan.md`（产品方案，定稿）；逐条决策原文：`docs/security_researcher_agent_design.md`（对齐记录，D1–D31）。
> 本文档把产品方案的每个构件映射到 u-disk 代码库的具体文件与机制，标出「现成 / 扩展 / 净新增 / 决策点」。

## 0.0 整体架构

```
┌─ 交互层（控制面的表面）
│    全屏 TUI：环境选择器（会话首屏，D17）+ 主交互流 + 常驻全局状态区（D15）
│    zhishi term · CDP 驱动系统浏览器
│
├─ harness 层（产品本体，「思维 ↔ 动手」双向循环）
│    组织上下文：安全认知语言（能力空间 + 通用循环）+ 分环境能力清单
│               + 研究记忆 + native-code 段（§3.1）
│    精准执行：  边界门控（D14：界内全自动、越界才确认）+ 代码闭环一等通道
│               + 后台长跑（env_bg / delegate_task，§3.2/§3.5）
│    蒸馏反馈：  research_events → 分域安全蒸馏弧 → 反哺注入（§1.4/§3.3）
│    主 agent：  任务识别 / 环境编排（创建权在人，D17）/ 环境状态 / 长会话试错
│    subagent：  上下文隔离 + 后台长跑 + 结构化回报协议（§3.5）
│    智能压缩：  状态外置五规则——task.md 状态卡是压缩的底气（§3.5）
│
├─ 支柱层（领域特化）
│    环境融合：四类环境同抽象（docker/vm/ssh/range），docker/VM 双原生基底，
│             环境类型 = Dockerfile|VM 模板 + setup + SKILL.md + 工具清单，
│             guest-exec 机内通道（断网 VM 可操作），快照回滚（§1.3）
│    原生工具：100% 在环境里，环境类型即工具清单，七环机制
│             （声明→安装→发现→描述→调用→教会→演进）（§1.5）
│    原生代码：环境居民（D27），挂载为桥，编译-运行-调试闭环在环境内（§1.1/§1.2）
│
├─ 宿主层（只有三样东西）
│    控制面（LLM/harness/共享表面）+ 环境接入件（docker/ssh/hypervisor CLI）
│    + 应用运行时（Tauri 无窗口宿主：sidecar Owner / Panel API PTY / CronTask / 日志）
│
└─ 数据层（状态全外置）
     环境：代码 + 产物 + task.md 状态卡（研究对象全在环境内，D27）
     SQLite：research_events + 记忆 + 蒸馏弧 · config.json：environments（keyPath，D-T4）
```

**主循环（一次研究的完整链路）**：探测 → 注入（能力清单）→ 人选环境（D17）→ 写代码（环境内）→ 编译/运行/调试（同一 PTY）→ 结构化记录（research_events）→ 蒸馏成弧 → 反哺下次注入。

**横切安全模型（D14）**：边界之内全自动（跑样本、打 exploit 是研究目的本身），审批只剩越界动作；env≠host 硬闸；环境内全程留痕静默记录。

**范围约束**：不考虑便携/U 盘场景（D7）；首批不提供插件、只有内置能力（D8，见 §2）；本体是协作不是打包（D9）；环境是研究主体（D11）；CLI + agent 删除 GUI（D13，见 §1.6）。

---

## 0. 总览：设计构件 ↔ 代码现状映射

| 设计构件 | 代码现状 | 结论 |
|---|---|---|
| §1.1 原生安全（与工具协作的能力） | **本体是协作面，不是工具仓库**（2026-08-14 纠偏）：LLM 原生调用已有通道（env_exec/env_bg 环境工具 / 共享终端 / MCP；SDK Bash 已随 D25 删除）；cuse/terminator 哨兵管线是有状态工具的现成模板；LLM 自装工具的 PATH 落点已有 npm 先例 | **已落地**：发现-描述-调用-教会-反馈协作层（能力清单段注入 + system skills + research_events，§1.5）；打包收窄为环境基座 |
| §1.2 原生代码（编译-运行-调试闭环） | 传输层完整存在：Panel API `term open/write/read`（cursor 增量读 + closed 语义 + attachOnly 共享）+ Rust ConPTY；宿主无工具链——**按扶正后的定位也不需要**：工具链在环境类型里（§1.1） | **已落地**：闭环在环境内跑（env_exec / `docker exec`），宿主零安全工具；`native-code-loop` skill 已接通（§11 议题 A） |
| §2.1 插件 = 外挂工具 + skills + subagent | Claude Plugin 协议原先由 SDK `Options.plugins` 原生接线（SDK 已随 D25 删除）；`.zsp` 加密分发 + `cc-plugin` 安装全链路已落地 | **首批不提供**（2026-08-14 拍板）：能力全部内置交付；插件机制存量保留、后续阶段再开放（见 §2） |
| §3 内核（能力空间 + 通用循环认知语言） | system prompt 三层组装（`system-prompt.ts`）有现成注入挂点（零注入语义）；`InteractionScenario` 现为 desktop|cron（W2 收窄），security 场景已落地 | **已落地**：security 场景五段注入（认知内核/能力清单/代码原生通道/research-log 教学/研究记忆反喂） |
| §5 隔离执行（环境层：Docker/VM/靶场） | **环境层已落地**（`zhishi env` 族 + docker/VM 三驱动 + guest-exec + SSH 靶场，§11 议题 A 续二/续三）；SSH 靶场经 `env add --kind ssh` 纳管 | **已落地**：terminal create 参数化 + 环境配置管理 + 环境标记权限锚点（§1.3）；不造编排层、不建自有沙箱 |
| §7 harness 双向循环 | 组织上下文/精准执行的挂点全齐（systemPrompt.append / 边界门控 / output-guard）；蒸馏反馈的管线骨架完整在转（蒸馏弧） | **已落地**：安全语境注入（五段）+ 安全轨迹蒸馏弧（§1.4 D1–D4） |
| §8 交互 | 共享表面的机制资产（PTY/Panel API/SSE/审批链）全部可复用于 CLI 形态 | **拍板：CLI + agent，删除 GUI**（2026-08-14）：`zhishi agent` 入口已落地（全屏 TUI）；Tauri 壳转无窗口后台宿主；浏览器登录态走 CDP 驱动系统浏览器（见 §1.6） |
| §9 减法 | IM 全家 ~2.8 万行是最大头；多条暗线耦合（pet/task/scenario/system-prompt） | **P4 执行**，风险点已定位（见 §6） |

---

## 0.1 目标用户：研究员 × 协作面（2026-08-14 拍板；2026-08-17 校准）

> **校准（D29/D30 + 域包清单层）**：情报降级为横切层（D29）；CTF 是补充非主战场（D30）；白盒审计从工具类升格为研究域（whitebox 入枚举）；红队/恶意软件两域 2026-08-17 拍板**暂缓**（引擎件 Phase 3 与多环境编排随域挂起）。当前活跃域：binary / pentest / whitebox / ai-security（内容件齐，dogfood 等环境）。

设计文档 §1 锁定的目标用户：二进制、渗透、AI 安全、红队、恶意软件、威胁情报六类研究员。**产品是 AI × 安全研究的融合，不是工具仓库**——每类研究员对协作面五环（§1.5）的依赖重点不同，这决定了 skills / subagent / 蒸馏弧的优先级：

| 研究员 | 主用协作通道 | 优先 skills | 优先 subagent | 阶段 |
|---|---|---|---|---|
| **二进制** | 代码原生闭环（§1.2）+ r2/ghidra headless + 靶场 fuzz | `native-code-loop`、`vuln-triage`、`binary-exploit` | `fuzz-runner`、`crash-triager`、`vuln-hunter`、`hypothesis-tester`、`critic` | **P1 核心用户（活体已过）** |
| **渗透** | 环境层（pentest 环境类型）+ env_bg 长扫描 + env_exec 进攻链 | `pentest`（进攻决策链，已落地） | 无（env_bg+delegate_task 覆盖） | **内容件已落地（b3fe5c6），dogfood 等环境** |
| **AI 安全** | LLM 自身能力 + garak/promptfoo（ai-security 环境类型） | `ai-security`（五环测试方法论，已落地） | 无 | **内容件已落地（9e6e6bc），dogfood 等 Docker** |
| ~~**红队**~~ | ~~环境层（C2/代理/后渗透）+ CronTask 长任务~~ | ~~内网横向方法、痕迹管理~~ | — | **暂缓（2026-08-17）**：多环境编排引擎件随域挂起 |
| ~~**恶意软件**~~ | ~~静态分析协作 + 隔离执行硬需求~~ | ~~恶意软件静态/动态分析流程~~ | — | **暂缓（2026-08-17）**：env_bg Phase 3 随域挂起 |
| ~~**威胁情报**~~ | ~~浏览器（共享登录态）+ 爬取 + CronTask 定时抓取 + 情报蒸馏弧~~ | ~~情报关联研判方法~~ | ~~`intel-watcher`~~ | **D29（2026-08-17）：降级为横切层**——不建独立管线；抓取/盯梢/关联能力由消费域驱动建设 |

两个由用户构成反推回来的设计校正：

1. **恶意软件研究员让「隔离执行」从可选项升格**：原方案按「靶场在远程」把本地沙箱降级为可选，但恶意样本分析是六类用户里唯一**必须**保证不裸跑宿主机的场景——P2 前就位。**原生环境能力（§1.3）落地后有了具体载体**：VM 快照-传入-detonate-回滚工作流 + env≠host 硬闸，不需要自建沙箱。
2. **研究员分域 = 安全蒸馏弧的分域依据（2026-08-17 校准：七域 + ctf 补充 + intel 横切）**：`research_events.task_kind` 的枚举与蒸馏成弧按域划分（§1.4、§3.3），经验不跨域混压——二进制的 fuzz 经验和白盒的审计经验分开沉淀。

---

## 1. P1：原生代码链路 + 蒸馏闭环 + 首批工具

### 1.1 代码原生基座：工具链在环境里，不在宿主（2026-08-14 扶正）

**旧方案（已废弃）**：clang/lld 便携包 + Python embeddable 打进宿主安装包（~500MB–1GB），配下载脚本、externalBin 注册、两处 PATH 注入。废弃理由：与「工具不配合在本地，配合在环境里」冲突——宿主装工具链既重又违背研究主体在环境的定位。

**新方案**：**宿主零安全工具**。工具链（clang/gcc、汇编/链接器、Python、调试器）是 `dev` / `pwn` 环境类型的内容物（Dockerfile `apt install` 一行事）：

```
LLM 写代码 → 落在环境内（Write/Edit，共享表面可见、研究员可改）
           → 环境内编译/运行/调试（env_exec / zhishi term 进环境）
```

- **快速闭环不受损**：`docker exec` 的延迟与本地执行无感差异；写代码在环境内（交互在本机），编译运行在环境（研究在环境）。
- **白捡一个正确性**：exploit/PoC 天然不裸跑宿主机（§3.2 的 env≠host 硬闸从「约束」变成「默认如此」）。
- **随之取消的 P1 工作**：工具链下载/发布脚本、externalBin 注册、NSIS 宏、`buildClaudeSessionEnv` / `inject_terminal_env` 的 PATH 注入改动——**原 P1 最重的打包工程整块消失**，重心移到环境层（§1.3）。
- **宿主只保留**：应用自身运行时（Node.js，产品基建非安全工具）+ 环境接入件（docker CLI / 系统 ssh）。
- **R2 下载管线与统一接入管线保留**，服务对象收窄为：少数有状态 MCP 工具（cuse/terminator 既有）+ 环境引擎 bootstrap（见 §1.3）。

**前置依赖（P1 开工第一件事）**：Docker 引擎与 hypervisor **并行就位**——两者是一等并行基底，不是主备。「用户对环境零操作」意味着 zhishi 要包揽 bootstrap：会话启动检测 docker（`docker info`）与 hypervisor（Hyper-V `Get-VM` / VBoxManage / vmrun / virsh）→ docker 缺失则下载 Docker Desktop 安装包并引导安装（NSIS 内嵌 Git-Installer.exe 有内嵌安装器先例）→ WSL2 依赖在 Windows 上做系统检测与引导文案；Hyper-V 是 Windows 原生组件（Pro 以上自带），缺失走「启用 Windows 功能」引导，原生程度高于 Docker Desktop。按环境类型选基底：Linux 工具链/靶场走 docker，Windows 样本 detonate / 内核驱动 / 快照回滚走 VM。

### 1.2 编译-运行-调试闭环（传输层零新增；闭环在环境内跑）

闭环「写代码 → 编译 → 运行 → 看结果/崩溃 → 调试 → 迭代」的每一段在现有设施上的落点：

| 环节 | 现有设施 | 说明 |
|---|---|---|
| 写代码 | 原生 Write/Edit 文件工具，落环境内（D27） | 交互在本机；代码在环境内 |
| 编译/运行 | `zhishi term open/write/read`（CLI 参数解析 `src/cli/zhishi.ts:3633-3710`）→ sidecar 薄代理 `handlePanelProxy`（`admin-api.ts:5700-5740`）→ Rust Panel API（`src-tauri/src/panel_api.rs:128-248`） | cursor 增量读、UTF-8 边界安全、`closed:true` 后可读残留输出——**为 AI 轮询专门设计过**；`env up` 后 `term open --cmd "docker exec -it <c> bash"` 进环境编译运行 |
| 调试（gdb/r2/lldb 交互式） | 同一 PTY 通道；Rust 侧 portable-pty + ConPTY（`terminal.rs:112-217`） | 交互式调试器恰好需要 PTY，已就位；调试器在环境类型里 |
| 人在回路 | Panel API attachOnly 模式：AI 建的 `ai-` 前缀会话，人可随时接管敲键盘（GUI 时代的 `TerminalPanel.tsx` 前端已随 renderer 删除，接管走 `zhishi term`） | 「共事不代劳」已实现——终端是研究员看进环境的窗口 |
| 试错回滚 | loop fork（`forkLoopSession`，TUI `/fork`，2026-08-17 落地）+ 环境侧快照（§1.3） | exploit 迭代：会话层回滚思路，环境层回滚环境 |

**安放规则（2026-08-14，与 §1.5「工具全部跟着环境走」同源；2026-08-16 D27 修订：代码=环境的居民）**：**代码跟环境走，工具链跟环境走。** 代码（源码/构建产物/崩溃转储/exploit 迭代）的生命周期属于环境——持久、共享表面可见、研究员可编辑（D27：研究对象全在环境内，产出过界提取或快照保留环境）。工具链（clang/gcc/python/gdb，含 Windows 目标的 MSVC/WDK——进 dev VM 环境类型）是工具，按 §1.5 拍板 100% 在环境类型里，宿主零工具链。LLM 写代码走 Write/Edit 原生落环境，不经环境 shell 绕路。

**结论**：P1 在这一节只做一件事——把闭环的**方法知识**写成 system skill（`bundled-skills/native-code-loop/SKILL.md`），教 LLM「起 dev 环境 → 写 C 文件 → 环境内 `clang ... && ./a.out` → 崩溃进 gdb」，不需要任何新工程设施。LLM 侧教学注入走 `src/server/system-prompt-cli-tools.ts` 的既有模式（term/browser 用法已在 271-289 行注入）。

### 1.3 环境层：靶场 / Docker / 虚拟机原生对接（净新增，改动小）

> 2026-08-14 拍板：**原生环境能力**——Docker、虚拟机是智能体天然对接的执行环境。这一层把三件事统一收编：隔离执行（恶意软件样本不裸跑宿主机）、靶场层（Linux-first 工具）、可回滚的执行环境（快照）。

**关键洞察：Docker/VM 天然对接后，原「靶场层」大部分塌陷为本地能力。** Windows 上 Docker Desktop（WSL2 后端）让 AFL++ / metasploit / gdb+pwndbg 这些 Linux-first 工具直接 `docker run` 可用；VM（Hyper-V / VirtualBox / VMware / 远程 libvirt）提供快照-跑样本-回滚的恶意软件分析标准工作流。真正还剩「远程」的只是靶机靶场（SSH）。

**统一抽象：环境（environment）= 宿主机 / Docker 容器 / 虚拟机 / 远程靶场。** 每个 term 会话打一个环境标记（`host` / `docker:<container>` / `vm:<name>` / `range:<id>`），权限分档（§3.2）和轨迹记录（§1.4）都挂在这个标记上。

**扶正（2026-08-14）：环境是研究的主体，宿主机只是交互面。** 安全研究员的实际工作发生在环境里——容器里的 fuzz 环境、VM 里的 detonation 环境、靶机里的突破环境。**环境是可操作的**：用上 ZhiShi 后，用户对环境零操作——环境的建、配、跑、看、快照、销毁全生命周期由 LLM 在 ZhiShi 内驱动；工具不配合在本地，配合在环境里（含编译工具链，§1.1）。用户的交互在本机：共享表面（聊天/终端/浏览器）是看进环境、与环境协作的窗口——终端 attachOnly 可接管，但**不需要**。（2026-08-15 细化，D17：**初始环境选择强制由人做出，环境创建权专属人**——会话第一步是环境选择，agent 任何时刻不得自建、需要时向人请求；「用户零操作」= 零动手、有主权。）

**LLM 驱动的环境全生命周期**（每一环都是 docker/VM CLI 原生调用 + skill 教学，无新造编排层）：

| 生命周期 | LLM 的动作 | 载体 |
|---|---|---|
| 选定 | **会话第一步强制人选**（D17）：运行中环境 / 环境类型新建（D27：无「仅工作区控制面」）；主环境锚定后 agent 进场；后续所需环境也由人创建——agent 需要时向人请求，人一键建 | TUI 环境选择器（会话入口）+ 环境类型清单 |
| 建 | **创建权专属人**（D17）：人发起（选择器 / `zhishi env up`），构建自动化（docker build / VM 供应）；环境类型不够 → LLM 改环境类型或现写 Dockerfile，但创建动作仍由人触发；agent 需要不存在的环境 → 向人请求 | 环境类型（下文）+ 环境选择器 |
| 配 | `setup.sh` 之外的一次性配置：装额外包、部署目标、配网络 | 环境内 apt/pip，skill 教 |
| 跑 | 编译/执行/fuzz/扫描/detonate | `zhishi term`（env 标记） |
| 看 | cursor 增量读输出、崩溃现场、结果回收（产出文件落工作区挂载点） | Panel API 现成 |
| 快照/毁 | VM snapshot/revert；容器 commit/destroy；环境清理 | VBoxManage/virsh/Hyper-V cmdlet / docker CLI |

**赋能的载体 = 环境类型（environment recipe）**。我们不分发工具，分发「能把干净环境变成可用研究环境」的环境类型：

```
bundled-environments/<name>/
  Dockerfile          # 或 compose.yml——基础镜像 + 工具集 + 服务
  setup.sh            # 初始化：装依赖、部署目标、起服务、自检
  SKILL.md            # 何时用、怎么进、结果怎么采、怎么收尾（快照/销毁）
```

- **首批环境类型候选（定稿时）**：`pwn`（docker：ubuntu + gdb/pwndbg + pwntools）、`fuzz`（docker：AFL++ + 语料目录约定）、`malware-det`（**VM 原生**：Windows 分析 VM + 工具集 + 快照-传入-detonate-回滚工作流——VM 是此类环境类型的必选基底）、`pentest`（docker：kali 式工具集）、`crypto`（docker：python + 密码分析库）。实际已落地 9 个环境类型（dev/pwn/fuzz/fuzz-vm/pwn-vm/rev/pentest/ai-security/code-audit，见 §11 议题 A 续三）。每个环境类型对应一类研究员的主环境（§0.1）。**环境类型抽象对两类基底同构**：docker 环境类型 = Dockerfile + setup.sh + SKILL.md；VM 环境类型 = vmTemplates 条目（vmx/user/keyPath/snapshot，D22 直连真实 VM）+ 初始化脚本 + 快照约定 + SKILL.md。
- **播种照 bundled-skills 模式**：`tauri.conf.json` resources 映射 `bundled-environments/` → 落盘 `~/.zhishi/environments/`；`zhishi env up <recipe>` 构建/启动（docker build + run + 挂工作区），`zhishi env open <id>` 进终端——都是 `term open --cmd` 的具名快捷方式，LLM 也可以绕过快捷方式直接 docker CLI 原生驱动。
- **环境类型的本质是 skill 的可执行形态**：SKILL.md 教方法（教会环节），Dockerfile/setup.sh 把环境就位自动化（调用环节）——「教会」和「调用」在环境层合体。
- **网络约束**：基础镜像首次拉取需要网络，之后本地缓存；环境类型构建失败软降级（教 LLM 读 build 日志修环境类型——这本身就是蒸馏的好原料）。

**工程落点**：

1. **环境引擎 bootstrap（用户零操作的第一公里）**：会话启动**并行检测两类基底**——docker 引擎（`docker info` 通不通）与 hypervisor（Hyper-V `Get-VM` / VBoxManage / vmrun / virsh）。docker 缺失则自动下载 Docker Desktop 安装包并引导安装（NSIS 内嵌 Git-Installer.exe 有内嵌安装器先例；R2 管线做分发），WSL2 依赖在 Windows 上系统检测 + 引导文案；Hyper-V 缺失走「启用 Windows 功能」引导（Windows 原生组件，原生程度高于 Docker Desktop）。**docker 与 VM 是一等并行基底，按环境类型选基底**，都不是时再降级纯 SSH 靶场。**这是「用户对环境零操作」承诺的兑现点，P1 开工第一件事**。
2. **环境探测（发现）**：会话启动探测 docker CLI、Hyper-V（`Get-VM`）、VBoxManage、virsh、系统 ssh——结果进能力清单段（§3.1），LLM 看得见「这台机器有哪些执行环境可用」。
3. **terminal create 参数化（调用）**：`terminal.rs::create()` 加可选 `command` 参数（默认 shell 逻辑 442-455 行不变，给了 command 就 spawn 它）；Panel API `/term/open`（`panel_api.rs:128-185`）透传；CLI `zhishi term open --cmd "<任意接入命令>"`——`ssh user@target`、`docker exec -it <c> bash`、`ssh user@vm` 全部走这一条。
4. **环境配置管理（轻量）**：`config.json` 加 `environments: [{id, kind: ssh|docker|vm, host?/container?/vmName?, user?, keyPath?}]`，CLI 加 `zhishi env list/open <id>`（本质是 `term open --cmd ...` 的具名快捷方式）。凭据只存 keyPath 引用，不存密码——与 credential 黑名单体系（`path_safety`）对齐。
5. **VM 操作通道（教会，不造编排层）**：管理面（建/配/快照/回滚）由 LLM 原生调 VBoxManage / Hyper-V cmdlet / virsh——这些 CLI 本就是各 hypervisor 管理 API 的前端。**机内执行（传入样本/跑 detonate/取结果）走 hypervisor 客户机通道而非 SSH**：VirtualBox Guest Control（`guestcontrol run/copyto`）、Hyper-V PowerShell Direct（VMBus，仅 Windows 客户机）、vmrun `runProgramInGuest`、qemu-guest-agent `guest-exec`——全部由宿主机中介、无需 VM 联网，**断网隔离 VM 也能操作**，与 D14 出向控制天然兼容（malware-det VM 可彻底无网卡）；SSH 只用于联网的开发 VM/靶机。客户机凭据按 D-T4 属研究材料落工作区笔记。`malware-analysis` skill 教「快照 → guest-exec 传入样本 → detonate → 观察 → 回滚」流程——**红线：不自己造容器/VM 编排系统**，Docker/VM 的 CLI/API 已是成熟接口，我们只做 LLM 与它们的原生协作（D9 判据）。VM 环境类型的初始化脚本负责安装 Guest Additions / qemu-ga / VMware Tools 并自检（机内通道可用性 = 环境类型验收项）。若 CLI 文本输出解析/幂等性成为痛点，薄 MCP 包一层 API 是明确的升级路径，不进 P1。
6. **环境标记 = 权限锚点（安全原生）**：term 会话建时打 env 标记；宿主机上的 exploit 执行/对外发包升 HIGH 人工确认，容器/VM/靶场内降 MEDIUM 自动放行；**恶意样本相关操作 PreToolUse 硬闸强制 env ≠ host**。
7. **无人值守长跑**：fuzz/扫描类长任务挂 **CronTask Owner**（`ARCHITECTURE.md:183-215`：后端优先，无前端 Tab 也能拉起 Sidecar）+ Task↔CronTask 反向指针（task.md 即任务模板层的实例化落点，中途编辑立即生效）。

**现状基础**：无任何远程/SSH 内建支持——`TerminalManager::create()`（`terminal.rs:112-217`）参数固定（workspace_path/rows/cols/sidecar_port/terminal_id），无 command/shell 覆盖；CLI 无 env/remote 子命令。AI 今天就能在共享终端里 `term write 'ssh user@target\n'` 或 `docker run ...`（命令都在 PATH 上的话），但无连接管理、无会话参数化、无环境标记。

**隔离执行的最终形态**：P1 落地环境标记 + 边界门控（§3.2）；恶意软件分析链路（VM 快照工作流 skill + env 硬闸）随恶意软件域暂缓（2026-08-17，§0.1 校准）。不新建自有沙箱——Docker/VM 就是沙箱。

### 1.4 安全轨迹蒸馏闭环（扩展现有蒸馏弧）

**现状盘点**（`src/server/memory/`，这是对设计 §7 最值钱的存量资产）：

- **管线骨架完整在转**：`seedDistillArcTask()`（`distill-runner.ts:612`）播种认知蒸馏弧的 recurring Task（每小时，`dispatchOrigin:'system'` 不可见）→ cron tick 到 `/cron/execute-sync` 时哨兵 `<zhishi-distill-arc>` 短路普通 agent turn（`index.ts:5971-5979`）→ `runDistillArc()` 收集输入 → `runDistillLlmCall`（单发 one-shot LLM 调用（pi），`maxTurns:1`、`tools:[]`、`persistSession:false`、haiku 别名、5 分钟超时）→ `applyDistillResult` 容错合并（缺节保留原文、解析失败不写盘）→ 写 SQLite（唯一事实源）。
- **恒定尺寸注入点已打通**：`buildDistilledMemorySection`（`system-prompt.ts:133-153`）→ `systemPrompt.append` 的 `distilledMemory` 参数，内置路径注入，零注入语义（空库不注入）；外部 runtime 路径已随 W5 删除。
- **效果验收闭环（土匪回路）**：`zhishi memory search` 命中落 `recall_events` → 蒸馏 tick 前 `settleRecalls`（LLM judge 看引用前后 -5min~+2h 会话窗裁定）→ effective +0.2 / wrong **-1.0**（重罚）/ unused 不动分 → `listWrongMemories(8)` 错史回注蒸馏 prompt。
- **轨迹录制先例**：AppCraft `recorder.ts` 把 tool_use 落 trace step（挂在 assistant 消息流而非 canUseTool，覆盖全权限模式）+ `sediment-proposal.ts` 回溯式沉淀提议。

**差距与新增**（按依赖序；已全部落地 D1–D4，见 §11 议题 A ⑥）：

1. **结构化成败信号记录钩子**（原最大缺口）：现有蒸馏输入只吃会话元数据 + 尾部摘录（每会话 ≤6 条 × 160 字符），「拿 flag 成功/失败、卡在哪、哪个工具组合有效」埋在自由文本里。新增 `research_events` 表（`store.ts:179-255` 的 `openDb()` 建表区加表，类比 `gap_events`/`trust_events`）：`(id, ts, workspace, task_kind, outcome(success/fail/stuck), bug_class?, summary, trajectory_ref)`。记录入口两条：
   - LLM 自助：`zhishi research log` CLI 命令（照 `zhishi memory search` 的 `${group}/${action}` 路由模式，`zhishi.ts:3550`）+ system prompt 教学段；
   - 确定性钩子：cron 任务终态（类比 `recordTrustTransition`，`trust.ts:108`）。
2. **安全经验 memory kind**：`MemoryKind`（`store.ts:29`）当前硬编码 4 类（user-model/self-model/routines/reminder，KIND_CAPS 4/4/8/60）。加 `research-log` / `vuln-pattern` / `tool-combo` 三类 + 对应 `KIND_CAPS` / `HALF_LIFE_DAYS`（表 schema 不用变，kind 是 TEXT 列）。
3. **安全蒸馏弧（独立弧，不扩展现有弧）**：现有蒸馏弧是「这个人」的全局单弧（全工作区混压）；安全经验要独立节奏、按研究域分隔。照抄哨兵模式：新哨兵 `<zhishi-research-distill>` + 新 recurring Task（`index.ts:5971` 旁加路由分支）+ 新 runner（`distill-runner.ts` 的 `runDistillArc` 结构可参数化复用：输入源换成 research_events + 安全会话 transcript，prompt 契约换成「成功路径/失败根因/工具组合」分节）。
4. **反哺注入**：`buildSystemPromptAppend`（`system-prompt.ts:214-295`）加 `<zhishi-research-memory>` 段（照 `buildDistilledMemorySection` 模式，2000 字符硬顶 + 零注入语义）——挂在 §3.1 的 security 场景段之后。
5. **检索升级（P1 可缓）**：`searchEntries`（`store.ts:559-578`）是 substring includes + effectiveScore 排序；按 bug_class/工具维度检索先用结构化列查询（research_events 有列）补足，向量检索不进 P1。

**注意**：judge 证据窗（-5min~+2h 扫 sessions/*.jsonl）对长时间 fuzz 会话可能不够，安全蒸馏弧的 judge 窗要按任务时长参数化。

### 1.5 工具协作层（框架纠偏：本体是协作，不是打包）

> 2026-08-14 对齐：**这个智能体不是把安全工具打包进产品，而是让 LLM / harness / agent / subagent 更好地与工具协作**——重点在协作面：工具给 LLM 赋能，LLM 原生调用工具。同日扶正并拍板：**协作的主体在环境里，安全工具全部跟着环境走**（见下「工具安放」）——宿主机不做安全工具的探测/自装/描述，工具的唯一居所是环境类型定义的研究环境；本地堆一堆工具没有大用。

协作面的五个环节（每个都有代码落点）：

| 环节 | 回答的问题 | 工程落点 |
|---|---|---|
| **发现** | 这些环境里实际有什么？ | 宿主只探环境引擎（docker/hypervisor/ssh，§1.3）；安全工具发现 = 读环境类型清单（SKILL.md 声明）+ 运行中环境按需实查。结果存 session 上下文 |
| **描述** | LLM 看得见什么、何时该想到哪类？ | 能力清单段按五大类组织、**动态生成于实际探测结果 + 可用环境类型清单**（不是静态打包清单），注入 system prompt（§3.1）；空类零注入 |
| **调用** | LLM 的命令能不能直接跑？ | 控制面原生通道：环境工具 `env_exec` / `env_bg`（宿主执行类工具结构性不存在）、共享终端 `zhishi term`、有状态/长连接工具走 MCP（cuse/terminator 模式）；环境内：`zhishi env up/open/exec` 或直接 docker/ssh CLI——**默认 CLI，有状态才 MCP** |
| **教会** | LLM 会不会用、会不会判读输出？ | 每类工具/每个环境类型配 system skill（何时用、怎么判读、常见坑、工具缺失时的降级路径），§2.2 |
| **反馈** | 哪个工具组合/哪个环境类型有效、哪条路是死的？ | `research_events` 记录 + 安全蒸馏弧沉淀（§1.4）；工具组合与环境类型使用经验是 `tool-combo` kind 的核心内容 |

**协作对象分层**（环境扶正后）：

| 层 | 形态 | 内容 |
|---|---|---|
| **环境类型**（协作面的主体，§1.3） | 把能力投射进环境 | dev / pwn / fuzz / fuzz-vm / pwn-vm / rev / pentest / ai-security / code-audit 等环境类型（Dockerfile + setup.sh + SKILL.md），照 bundled-skills 模式播种；研究发生在环境类型起出来的环境里 |
| **控制面基座**（打进安装包，最小化） | 宿主只保留交互面与环境接入件 | docker CLI / ssh 检测即用（缺失走 §1.3 bootstrap）；**宿主不装任何安全工具，含编译工具链**——工具链在环境类型里（§1.1） |
| **环境内自装**（LLM 在环境里自己装） | 包管理器生态在环境内用 | 环境内 `apt/pip install` 是常态（环境类型可迭代）；宿主机自装降级为辅助（npm-global 先例保留，`~/.zhishi/pip-user` 可选） |
| ~~研究员已有工具~~（已取消，2026-08-14） | — | 宿主安全工具不进能力面：不探、不装、不教——harness 的安全工具 100% 在环境里；研究员自己怎么用宿主工具是其个人行为 |
| **有状态服务工具**（MCP） | 长连接/有状态才包 MCP | 安全工具的有状态服务跑在环境内、MCP server 随环境起（ghidra headless server 候选随 P2 评估）；cuse/terminator 属 AppCraft 桌面自动化，非安全工具层 |
| **外部 GUI**（永不内置） | 设计 §8.2 | IDA/Wireshark/Burp/x64dbg——LLM 走 headless/API 配合 |

**工具安放（2026-08-14 拍板）：安全工具全部跟着环境走，无例外、不分居。** 宿主零安全工具（含静态分析工具——宿主不探、不装、不进能力清单）；「研究员已有工具」层取消——研究员宿主机上装了什么是其私产，与 harness 无关。范畴澄清：研究员自带 GUI（IDA/Wireshark/Burp，§8.2 外部工具）、环境接入件（docker/ssh/hypervisor CLI）、cuse/terminator（AppCraft 桌面自动化）都不属于安全工具层，不构成例外。分开走的代价不是实现复杂度，是业务逻辑不自洽——发现/描述/教会/反馈全要双轨。

**工具跟着环境走的机制**：
- **声明**：工具 = 环境类型内容物。docker 环境类型在 Dockerfile 里 install，VM 环境类型在初始化脚本里供应；环境类型另带一份给 LLM 看的工具清单声明（SKILL.md frontmatter），不必解析 Dockerfile
- **安装**：随环境构建/供应完成；VM 侧装完打快照——工具安装成本被镜像层缓存/快照一次化（ghidra 数百 MB 大件也只付一次）
- **发现**：读环境类型清单（静态、零探测）+ 运行中环境按需实查（覆盖环境内自装部分）；宿主只探环境引擎（§1.3 bootstrap）
- **描述**：能力清单按环境分组，源自环境类型清单——LLM 看见「哪个环境有什么」；空类零注入不变
- **调用**：永远进环境调（`zhishi term` / docker exec / ssh 进 VM），宿主侧无安全工具可调
- **教会**：环境类型 SKILL.md + 工具类 skill；降级路径 = 换环境类型 / 环境内自装 / 改环境类型
- **反馈**：research_events 记 env × tool 组合（§1.4）
- **演进**：环境内自装 → 沉淀回环境类型 → 重建镜像 / 重打快照

**随之消失的工作**：宿主安全工具探测、「研究员已有工具」进能力清单、宿主工具下载/签名管线——统一接入管线收窄为只剩环境引擎 bootstrap（§1.3）。

**统一接入管线已作废（D31，2026-08-17）**：工具跟环境走，加一个工具只剩环境类型 Dockerfile + SKILL.md 两处（同一目录），宿主零工具（无下载/签名/registry）——`BUNDLED_TOOL_REGISTRY` + 通用下载脚本不再建设。`category` 字段保留，作为能力清单按类组织的事实源。

**工具与 skill 成对出现**：skill 不绑定"我们分发的工具"，绑定"这一类协作"——skill 里写清工具缺失时的降级路径（进环境 / 环境内自装 / 提示研究员 / 换工具）。

### 1.6 产品形态：CLI + agent，删除 GUI（2026-08-14 拍板）

**定位判据**：目标用户是六类研究员，不是小白/新手/菜鸟。研究员的操作习惯在终端——有界面就要考虑窗口、面板、导航、设置页等一堆 UI 因素，对研究员而言纯 UI 是负担不是助力。**对社区而言产品的好坏是使用的好坏，并非界面；我们的界面呈现在 CLI / 交互 CLI 的可操作性上**——`zhishi agent` 的渲染、流式、中断、审批、多环境操作手感，打磨标准等同于别人的 GUI 设计标准。

**拍板记录**：用户投票 CLI、删除 GUI——**不交付就是删除，不做多余保留**。附议理由：保留「不交付但维护中」的 GUI 是最坏选项（维护税照付、无人受益）；删除后 P4 减法从「精准切除 renderer 功能」简化为「删表面」，难度降一档。修正记录在案：**删的是界面不是宿主**——Rust 层（sidecar Owner / Panel API PTY / CronTaskManager / 统一日志）转为无窗口后台宿主保留。**2026-08-15 定死：明确不需要 GUI，不设恢复路径**——原可逆性声明（dogfood 证伪则恢复 GUI）撤销；dogfood 证伪信号（D21）触发的是 TUI 交互形态的重做，GUI 不在选项内。

**证据链（2026-08-14 调研，行为证据而非问卷；该人群无直接 GUI/CLI 偏好调查）**：

| 证据 | 指向 |
|---|---|
| Kali Linux：600+ 工具的专用 OS，2022 年 500 万+ 下载；CTFd-Whale/HTB/TryHackMe 全部环境化 | 工作主体在**环境**里，不在本机——环境层是核心（§1.3） |
| Kali Top 10 工具中攻击链全是 CLI（nmap/metasploit/hydra/john/sqlmap）；GUI 集中在领域分析工具（Burp/IDA/Wireshark/Cobalt Strike） | 研究员不排斥 GUI，排斥的是「给 agent 套 GUI」；领域 GUI 不重做（设计 §8.2）成立 |
| can1357（安全研究员/逆向工程师）自造的 AI agent oh-my-pi 终端原生，半年 15k+ star、~400 releases | 这个人群为自己造 agent 时选终端 |
| XBOW 登顶 HackerOne 美国榜（~1,060 漏洞），完全无头；2026 年 $120M C 轮估值超 $1B | 安全 AI 的最成功案例没有 UI |
| Claude Code 纯终端 agent：run-rate $500M（2025-09）→ $2.5B+（2026-02），SO 2025 调查 10% 使用率（发布最晚、增速最快） | power user 正向终端 agent 迁移 |
| 国内：CTF/pwn 入门即 VM/Docker + 命令行工具链；CMD 渗透速查表流行；exploitdb CLI「专为安全研究员设计，无需浏览器」；奇安信/绿盟 AI 渗透产品走无头自动化 | 国内习惯同构、产业同向 |
| **反向数据**：大盘开发者 GUI 形态份额仍领先（Cursor 18% vs Claude Code 10%；Copilot 29% 工作中使用） | 拍板依赖「锁定终端原生细分」这一定位，不是普适规律；2026-08-15 已定死不做 GUI——证伪信号（D21）触发 TUI 重做，不指向 GUI 回归 |

**落地形态**：

- **sidecar 是无头载体**（连接 环境↔工具↔LLM↔能力）。架构上 Sidecar Owner 模型本来就支持无头（CronTask/Agent Owner 无前端拉起 sidecar，`ARCHITECTURE.md:183-215`），`zhishi` CLI 已有单端口连 sidecar 的约定——**CLI 形态的架构基础是现成的**。
- **新增 `zhishi agent` 交互入口（P1 核心交付物之一）**：`src/cli/` 现在只有能力命令（term/browser/memory/task…），没有 agent loop。新增交互式 REPL：复用 sidecar 会话 REST + SSE 流式（`sse.ts` 事件流），渲染工具调用/输出，支持中断与中途纠偏（对应 mid-turn 注入）。越界动作的确认（D14）在 CLI/TUI 内完成——SDK canUseTool 的 SSE 卡片体系已随 D25 删除。
- **多环境观察**：研究员用自己的终端窗口/tmux 并行看多个环境（`zhishi term read -f` 跟随输出即可）；产物留环境（过界提取），编辑器/查看器用研究员自己的。
- **浏览器登录态共享的 CLI 原生承接**：改为**驱动研究员自己的系统浏览器**（CDP / Playwright 接管 Chrome/Edge，`agent-browser` skill）——比内嵌 WebView2 更原生（登录态本来就在那里）；内嵌 `zhishi browser` 命令组已随 W6 删除（browser.rs 无父窗口运行期必失败）。
- **Tauri 壳转为无窗口后台宿主**：Rust 层不删——sidecar Owner 管理、Panel API、CronTaskManager、统一日志都长在 Rust 层，保留为无窗口/托盘基础设施；**renderer 删除**（P4 从「砍功能」变为「删表面」，见 §6 注）。远期可评估抽 `zhishid` 纯后台宿主（Rust 层本就不依赖窗口），非 P1 事项。
- **开放问题（P1 细化时定）**：Panel API 的 PTY 持有方目前在 Rust/Tauri 层（`terminal.rs`），无窗口宿主下不变；若远期抽 `zhishid`，PTY 持有随壳走，sidecar 侧无感。
- **搭子形态**：桌面搭子（pet.rs）已随 renderer 删除；搭子降为 TUI 状态行/系统通知（「漏洞利用·执行中」打在状态区或 Windows toast），§8.5 的状态机逻辑保留、呈现层换掉。

---

## 2. 内置能力交付形态（设计 §2；首批不提供插件）

> 2026-08-14 拍板：**首批只有内置能力**——bundled 工具（§1.5）+ system skills（§2.2）+ harness 内建（§3）。插件是后续阶段的扩展入口，首批不交付、不做安全场景适配。

### 2.1 插件机制：存量保留，首批不开放

代码库现状（后续开放时零新增可用）：Claude Plugin 协议由 SDK `Options.plugins`（`agent-session.ts:17796-17824`）原生接线，一个插件 = 一个含 `.claude-plugin/plugin.json` 的目录，`.mcp.json`（外挂工具）/ `skills/`（方法）/ `agents/`（subagent）/ `hooks/`（事件钩子）全部由 SDK 自动加载；安装管线（`plugins/url-resolver.ts` 三源 + `installer.ts` + `store.ts`）、三层 enable 语义、`.zsp` 加密 + 许可串、`plugin-assistant` + `zhishi plugin init/pack/keygen/verify` 全链路已落地。

首批的处理：

- **不交付任何插件形态的能力**——设计 §2.1 的三样扩展（外挂工具/skills/subagent）在首批全部以内置等价物交付：工具走 §1.5 统一管线、skills 走 §2.2 system skill、subagent 走 §3.4 内置 agents 目录（不走插件打包）。
- **机制不下线、不宣传**：`Options.plugins` 注入链路和 `.zsp` 体系留在代码库（P4 减法也不砍），但首批产品面对研究员不开放「安装插件」作为能力获取方式；开放时机随后续阶段对齐。
- **已知限制（后续开放时再处理）**：插件内 agents/skills 由 SDK 整包加载，不能细粒度启停（`agent-session.ts:490` 注释：SDK 无过滤 API）。

**⚠️ 命名陷阱（P4 执行时必读）**：`src/server/plugin-bridge/` 是 **OpenClaw IM channel 插件桥**（随 IM 一起砍），`.zsp`/cc-plugin 体系在 `src/server/plugins/`（保留）。两者名字像、命不同。

### 2.2 安全 skills：首批能力的主交付通道

结论：首批安全 skills 走 **system skill** 路径（与工具接入管线锁步演进，utility 路径没有更新通道，不能用）：

1. 每个 skill 建 `bundled-skills/<name>/SKILL.md`（frontmatter 必填 `name`/`description`，description 写足触发场景——这是 LLM 选择 skill 的唯一依据；需要 Bash 类工具加 `allowed-tools`）；
2. 名字追加**两处**清单：`src-tauri/src/commands.rs:1240`（Rust 权威）+ `src/server/index.ts:1886`（Node 镜像排除清单）——漏改任一侧不报错、静默 double-seed，批量新增时建议加构建期对账校验；
3. bump `SYSTEM_SKILLS_VERSION`（一批 skill bump 一次）；
4. 平台限制同步 `commands.rs:1280` + `src/server/utils/platform.ts` 两处屏蔽清单。

运行时链路零改动：Rust 强制覆盖落盘 `~/.zhishi/skills/` → `syncProjectUserConfig`（`agent-session.ts:486-694`）symlink 进 `<workspace>/.claude/skills/` → 自研 loop 侧 skill 装载（`loop/skills.ts`；SDK `settingSources` 自动扫描已随 D25 删除）。

**首批 skills 建议**（对应设计 §3.3 任务模板层 + §1.2 闭环；2026-08-17 校准：`ctf-pwn` 已更名 `binary-exploit` 实战框架，D30 CTF 是补充非主战场）：
- `native-code-loop`（编译-运行-调试闭环方法）
- `binary-exploit`（二进制利用实战：0day 挖掘/1day 复现/exp 武器化）
- `vuln-triage`（崩溃研判 → bug_class 归类）
- `range-ops`（靶场连接与操作规范）

---

## 3. harness：内建「安全原生 × 代码原生」的双向循环（设计 §0/§1/§7）

harness 的三件内建能力（组织上下文 / 精准执行 / 蒸馏反馈）不是中性管道——每一件都要回答「安全原生」和「代码原生」两个支柱各自在这里落什么。这是本节与通用 ZhiShi harness 的本质区别：

| | 安全原生（Native Security） | 代码原生（Native Code） |
|---|---|---|
| **组织上下文** | 能力空间 + 通用循环的认知语言；五大类工具按类组织描述，LLM 看得见「我有什么动手能力」 | 工具链与闭环通道写进语境：LLM 知道自己能直接写 C/汇编并立即编译运行调试 |
| **精准执行** | 权限按环境标记（容器/VM/靶场 vs 宿主机）重标定；后台 fuzz/扫描 agent 的闸门竞态修复 | 编译-运行-调试闭环是一等执行通道（不是裸 Bash 的临时组合） |
| **蒸馏反馈** | 成败轨迹 → 漏洞根因/死路/工具组合经验，按研究域成弧 | 编译错误→修复、崩溃→根因、exploit 迭代路径是最优先蒸馏的轨迹类型 |

### 3.1 组织上下文（智能体 → LLM）

- **安全语境注入（安全原生）**：`buildSystemPromptAppend`（`system-prompt.ts:214-295`）现有 L1 身份 → 蒸馏记忆 → L2 渠道 → L3 场景（L1.5 persona 维度化已移除，2026-08-17）。新增：
  - `InteractionScenario` 加 `security` 场景类型（W2 收窄为 desktop|cron 后加 security，已落地）；
  - `<zhishi-security-kernel>` 段：能力空间 + Recon→Analyze→Construct→Execute→Evaluate→Distill 通用循环的**认知语言**（给 LLM 的参照，非锁死流程——与设计 §3 定位一致，用 prompt 承载而不是状态机承载）；
  - 五大类工具按类组织的**能力清单段**：不是 MCP 工具 schema 的堆叠（那是引擎自动做的），而是用一句话/类告诉 LLM「渗透/密码/白盒/二进制/AI 各有什么在手、何时该想到哪类」——清单**动态生成于会话启动时的环境探测结果**（§1.5 发现环节），LLM 看到的是这台机器上实际可用的协作对象，未检测到的类零注入；
  - `<zhishi-research-memory>` 段：§1.4 安全蒸馏产物。
  - 全部遵循零注入语义（空即不注入）+ 每段硬字符上限。
- **代码原生语境注入**：`<zhishi-native-code>` 段——工具链在环境类型里（`dev` 环境一开即有 clang/python/gdb，宿主不装）、闭环通道用法（`zhishi env` + `zhishi term` 系列）、环境标记约定（§1.3）、「写完 C/汇编直接在环境里编译跑，不要绕脚本语言」的行为约定。细节方法知识不进 prompt，放 `native-code-loop` skill（§2.2）按需加载——prompt 段只负责让 LLM **知道这条路存在且是一等的**。
- **窗口管理**：现成——`broadcastBuiltinContextUsage`（`agent-session.ts:3408-3466`）+ `model-capabilities.ts` 注册表校准 auto-compact 窗口；deepseek-v4-pro 1M 窗口走 `applyContextWindowSuffix` 已支持。
- **长任务中途纠偏**：现成——mid-turn 注入队列（`messageGenerator` + `replay-user-messages` 确认，`agent-session.ts:23068-23360`）。

### 3.2 精准执行（LLM → 智能体）

- **代码原生的执行通道（P1 核心）**：编译-运行-调试闭环的传输层现成（§1.2），harness 层要做的是把它从「裸 Bash 的临时组合」提升为**一等通道**：
  - LLM 写的 C/汇编落盘 → `zhishi term` 编译运行 → 崩溃进 lldb/r2 调试——全链路在同一个 `ai-` PTY 会话里，cursor 增量读保证长输出（fuzz 日志、调试器交互）不丢；
  - loop fork（`forkLoopSession`，TUI `/fork`）作为 exploit 试错的回滚通道，写进 `native-code-loop` skill 教 LLM 主动用；
  - 工具链在环境类型里（§1.1）保证环境内执行入口（env_exec / `zhishi term` 进环境）能直接摸到 clang/python。
- **安全原生的正确定位：边界安全 + 留痕，不是操作审批（2026-08-14 更正）**：早期草案把「安全原生」理解成「危险命令逐条弹审批」——那是本地 agent 时代的模型（保护用户本机）。本架构下研究主体在一次性隔离环境里，**跑恶意样本、打 exploit 就是研究目的本身，边界之内不需要任何审批**（对这类操作弹审批等于 msfconsole 问「确定要利用吗」）。安全原生落在边界上：
  1. **保护本机不受环境影响**：环境默认摸不到宿主文件系统（挂载控制）、宿主凭据（API key/SSH key）绝不泄进环境、环境→本机写入受控；
  2. **出向控制（egress）**：网络出站策略（样本不能回连、研究流量可审计）、产物提取时检查——能离开环境的东西是唯一真风险；
  3. **环境生命周期卫生**：默认一次性、用完即毁、快照回滚、无残留；
  4. **供应链完整**：进环境的工具/镜像签名校验（D-T2）、凭据外部引用（D-T4）；
  5. **留痕而非审批**：环境内一切操作完整记录（可复现/可审计/法律保护），静默记录，不打断研究员。
  **审批只保留一件事：跨越边界的动作**（环境写宿主、用本机凭据、改网络策略、销毁含未提取成果的环境）。边界之内 LLM 全自动。
- **权限模型重标定（已落地，边界门控）**：SDK 时代的 canUseTool 风险分级（`classifyToolRisk`，LOW/MEDIUM 自动放行、HIGH 人工应答）已随 D25 整体删除，权限模型重标定为**边界门控**（`loop/boundary.ts` 入向 deny + `loop/output-guard.ts` 出向净化，规则即数据、allow/deny+reason 回注模型）——判定维度从「命令危不危险」改为「是否跨越环境边界」：env≠host 内的编译/执行/调试/样本操作全自动；越界操作（写宿主、宿主凭据、网络策略变更、销毁有成果环境）走高优先级确认。恶意样本操作硬闸强制 env≠host（这条保留，它是边界规则不是审批）。
- **⚠️→✅ 已知缝隙（D-T3 记录保留；SDK 机制已随 D25 删除）**：~~后台 subagent（`run_in_background`）从不走 canUseTool，唯一闸门是 PermissionRequest hook（`background-agent-permission.ts`），且 `task_started` 登记与该 hook 是两条无序通道，首个工具调用可能 fail-deny。修复：hook 未命中时有界等待注册（`waitForBackgroundRegistration`）+ 前台 agent 负缓存，竞态窗口闭合~~——该竞态修复随 SDK 一并作废；后台长任务现走 `env_bg`（start/poll/log/kill/list）+ CronTask Owner。
- **多 runtime 约束**：external runtime（CC/Codex/Gemini CLI）已随 W5/D20 整体删除，唯一引擎 = 自研 loop（pi 底座，`src/server/loop/`）；canUseTool/hooks 等 SDK 机制随 D25 删除。

### 3.3 蒸馏反馈（循环越转越好）

见 §1.4。两个原生对蒸馏的要求：

- **安全原生**：`research_events` 的 `task_kind` 按研究域取值（binary/pentest/ai-security/ctf 等；intel 是横切标签，D29），`bug_class` 枚举即 §4 输出侧本体——蒸馏产物按研究域成弧（经验不跨域），不混进通用用户认知弧。
- **代码原生**：编译错误→修复、崩溃→根因研判、exploit 迭代（哪次改动让 primitive 成立）是**最优先蒸馏的轨迹类型**——这类轨迹有确定性信号（编译退出码、崩溃信号、flag 到手），比自由文本会话更容易做高质量结算，`research_events.outcome` 的记录钩子优先挂这些确定性事件。

架构定位不变：**挂在已有记忆/蒸馏子系统，是 distill 弧的领域扩展，不是新子系统**（与宪章 §4.2 任务弧的工程映射一致）。呈现红线遵守 COWORK §3：蒸馏层永远不上界面，产出只能以搭子提议或 skill 沉淀形式浮现。

### 3.4 内置 subagent（首批不走插件）

首批不提供插件，subagent 以内置形态交付：agent 定义（folder 布局 `<name>/<name>.md`）随安装包分发（`bundled-agents/`），照 system skills 的播种模式落盘到**用户级 `~/.zhishi/agents/`** → 装载走 `src/server/agents/bundled-agents.ts` → 主 loop 的 `delegate_task` 工具委派（深度限 1，`loop/subagent.ts`；SDK `Options.agents` + Task 工具已随 D25 删除）。

- 已落地：`fuzz-runner`（长跑 fuzz + 崩溃收集）、`crash-triager`（崩溃去重 + 根因初判）、`vuln-hunter`、`hypothesis-tester`、`critic`；~~`intel-watcher`~~（情报降级横切层后不建独立管线，D29）——后台长任务形态，压在 §3.2 的边界门控之后交付。
- 与 skills 的分工：skill 教「怎么做」（方法知识，主 agent 就地执行）；subagent 接「值得隔离上下文或后台长跑的事」（fuzz 几小时的输出不进主会话上下文）。

---

## 3.5 主 agent、subagent 与智能压缩的安全定制（2026-08-14 对齐）

harness 的安全定制落在它必须承受的三个场景特征上：**长时**（fuzz 跑几小时~几天——会话/任务跨重启存活，挂 CronTask Owner）、**多环境**（并发 env 拓扑是上下文一等公民）、**确定性信号丰富**（编译退出码/崩溃信号/flag——比自由文本好结算，蒸馏与压缩都要利用的结构性优势）。

**主 agent 职责**（自研 loop 路径锁定，§3.2）：任务识别（task_kind → 选环境类型/skills）、环境编排（D12 全生命周期驱动；**创建权在人**——需要新环境时向人请求，D17）、环境状态管理（哪些 env 在跑、快照点）、长会话试错（exploit 迭代走 loop fork——思路可回滚 + 环境可快照）。边界审批（D14）是它唯一主动打断研究员的理由。

**subagent 存在理由 = 上下文隔离 + 后台长跑**，安全场景两条触发条件都高频：`fuzz-runner`（fuzz 海量输出不进主上下文；驱动 fuzz 环境运行——环境由人创建，D17；小时~天级）、`crash-triager`（崩溃去重 + 根因初判批处理）、`vuln-hunter` / `hypothesis-tester` / `critic`（域内子任务分工，§3.4）。**回报协议**：subagent 返回结构化 outcome（与 research_events 兼容：task_kind/outcome/bug_class/summary/trajectory_ref），不返回原始日志——轨迹落环境内文件，回报只带引用 + 结论。

**智能压缩的安全定制**（通用「摘要成散文」对安全研究是灾难——`0x7ffffffde3a8` 被概括掉 = 根因丢失；底座现成：auto-compact + 窗口校准，定制的是保留策略与外置状态卡）：

1. **状态外置**——研究状态卡（已验证事实/当前假设/死路清单/当前阶段/环境清单）持久化在环境内 `task.md`（§1.3 工程落点 7 的同一落点）；压缩的底气来自状态外置，上下文才敢激进压缩
2. **确定性事实不可压缩**——地址/偏移/mitigation 标志/bug_class/flag 逐字保留
3. **大输出引用化**——crash dump/fuzz 日志/tool 输出落盘，上下文只留「结论 + 文件指针」
4. **死路清单永留**——压成「试过 X → 死于 Y」一行一条，永不丢弃（防重踩 + 蒸馏原料）
5. **阶段感知保留**——通用循环阶段决定保留策略：Recon 期背景收集可压，Exploit 期内存布局/原语状态必须全留

---

## 4. 抽象层 MVP（设计 §4，轻量类型化）

- **输出侧（本体约束输出）**：安全轨迹/漏洞实体的轻量 schema 落在两处——(a) `research_events` 表列即 schema（`task_kind`/`outcome`/`bug_class` 枚举值在 system prompt 里声明，LLM 经 `zhishi research log` 写入，CLI 侧校验枚举）；(b) 安全蒸馏弧的 prompt 分节契约（照 `buildDistillPrompt`/`applyDistillResult` 的「分节标题契约 + 容错合并」模式）。不做独立本体系统。
- **输入侧（图结构扩充输入）**：P3 情报阶段再接，MVP 不做。落点预留：情报实体（CVE↔漏洞↔攻击者）存 SQLite 新表，检索结果作为 context 注入段——不上面向可视化的图系统（设计 §8.3：图是展示不是交互）。

---

## 5. P2 / P3 展开要点

**P2 漏洞挖掘**（依赖 P1 管线 + 闭环验证）：
- fuzz 工具链（AFL++ 无原生 Windows 支持 → **本地 Docker 跑**（§1.3 环境层，压测容器工作流）；或 WinAFL 走 bundled）；
- ghidra headless（大件，按需下载）；
- 补丁 diff 场景：浏览器共享登录态看 diff + `native-code-loop` 技能复用；
- 后台 fuzz agent 常态化 → 走 `env_bg` + CronTask Owner（§3.2 的 PermissionRequest 竞态已随 SDK 删除失效）。

**P3 情报**（已随 D29 降级为横切层，不建独立管线；抓取/盯梢/关联能力由消费域驱动建设）：
- 爬取/检索：浏览器（共享登录态；CLI 形态下为 CDP 驱动系统浏览器，§1.6）+ `download-anything` skill + CronTask 定时抓取，全现成；
- 情报实体表 + 关联检索注入（§4 输入侧）；
- 情报 ⇄ 漏洞交叉：补丁 diff 喂挖掘 = 情报弧产物注入漏洞场景 prompt——两条蒸馏弧的产物在注入层交叉，不需要新机制。

**P4 减法**：见 §6 工作量地图。

---

## 6. P4 减法：工作量地图与风险点

> **注（2026-08-14 删除 GUI 拍板后）**：P4 减法性质改变——renderer 整体**删除**（不交付=删除，不做多余保留；回取走 git 历史），从「精准切除 UI 功能」简化为「删表面」，§6.1 表中所有 renderer 侧工作量与耦合风险（Settings 巨石、ImSettings、i18n、SSE 白名单对账的大部分）随之消失；减法剩余主体 = **后端功能砍除**（IM Bot 全家、多 Provider、需求单、想法等 server/Rust 侧）+ **Rust 宿主无窗口化**（托盘/服务形态、去 webview 初始化）。兜底表面就是 CLI 本身。

### 6.1 量级估算

| 砍除项 | 代码量 | 耦合度 | 关键落点 |
|---|---|---|---|
| IM Bot 全家 + 应答中心 | **~2.8 万行**（Rust `src-tauri/src/im/` 2.3w + inbox + TS ~5.5k） | 高 | 含 `src/server/plugin-bridge/`（3300 行，OpenClaw IM 桥，勿误伤 `src/server/plugins/`） |
| 通用生产力 skills | 4 目录（docx/pdf/pptx/xlsx） | 低 | 双清单同步 + 老用户已 seed 目录清理策略 |
| 多模型 Provider | preset 表（`config-types.ts:1356`，16 个 LLM preset）+ probe/verify + ~1.5k 行 UI | 中 | ~~**`src/server/openai-bridge/` 不能砍**——它是协议传输层，收敛到 deepseek 主模型后仍依赖~~（判断已翻案：M4c 随 SDK 删除，OpenAI 协议 provider 由 pi 原生直连） |
| gemini-image / edge-tts | 2 工具 + ~1k 行散落 | 中 | builtin media → 一等附件通道要留（codex 图像生成也用） |
| 需求单 | ~1k 行 | 低 | `admin-api.ts:8060-8455` + webhook + SSE 白名单一处 |
| capability-forge / skill-creator | 2 目录 + Chat 输入区注入 | 中 | `Chat.tsx:2432-2440` 造能力模式 |
| 技能市场/安装 | ~2.9k 行 | 中 | 砍 `skills/url-resolver.ts`，**留 `plugins/url-resolver.ts` 的 GitHub 源**（github 保留项依赖） |
| MCP 配置面板 | UI 为主 | 中高 | **只能砍皮**：`/api/mcp/enable` + 哨兵解析管线是 AppCraft/插件/.zsp 的依赖 |
| 想法收集 | ~1.7k 行 | 中高 | `ThoughtPanel` 长在任务中心目录里，「派发想法为任务」入口要去留决策 |

### 6.2 耦合风险点（按危险度排序，探查实测）

1. **`plugin_licenses` 表寄居 memory.db**（`memory/store.ts:246`）——记忆（留）与 .zsp 许可（留）互相寄居，清理 schema 时双向误伤风险。
2. **搭子 pet.rs 监听 IM 审批事件**（`pet.rs:87-125` + `DesktopPet.tsx:62` 轮询）——砍 IM 后变死监听，需从搭子剥离；同时搭子按设计 §8.5 重定位为「场景 × 循环状态」。
3. **定时任务的 IM 派发字段**：`notificationBotChannelId`（`shared/types/task.ts:167`）、`ImCronContext`（`agent-session.ts:87-89`）——`SessionCronContext` 必须保留，只清 IM 部分。
4. **SSE 三方对账测试**：`sse-whitelist-crosscheck.unit.test.ts` 强制 broadcast 字面量 = `SseConnection.ts` 白名单 = `sse.ts` 优先级三方一致，删事件必须三处同步，否则 CI 红。
5. **scenario 'im'/'agent-channel' 贯穿 7 处**：system-prompt 拼装、agent-session、index、各 external runtime——砍 scenario 逐处验。
6. **Settings.tsx 是 12007 行巨石**：providers/capabilities/feedback/partner 全堆一个文件 + `VALID_SECTIONS` 路由表 + i18n——每个 section 删除牵动导航深链。
7. **SYSTEM_SKILLS 双注册**（`index.ts:1886` ↔ `commands.rs:1240`）：删 skill 两边同步 + bump 版本 + 老用户残留目录策略。
8. **想法/需求单的数据残留**：`thought.rs`（1269 行 Rust 存储）、`supportUserToken`——删除后老用户数据迁移策略要定。

---

## 7. 决策点汇总

| # | 决策点 | 结论 | 影响阶段 |
|---|---|---|---|
| ~~D-T1~~ | ~~工具链/大工具分发策略~~ | **已解除**（2026-08-14 不考虑便携/U 盘场景；随后 §1.1 扶正进一步取消宿主工具链打包——工具链进环境配方，宿主零安全工具） | — |
| ~~D-T2~~ | ~~工具下载签名校验~~ | **已定（2026-08-14）：加签名，分层用各层已有信任根**——自分发 MCP 二进制（R2）加 ed25519 签名（复用 `zsp-crypto.ts` 原语，密钥离线保管）；Docker Desktop 安装包依赖微软 Authenticode + 官方哈希对照，不自签；环境配方镜像 Dockerfile 固定 digest（`@sha256:`），官方镜像优先。不自建签名体系 | P1 |
| ~~D-T3~~ | ~~后台 agent PermissionRequest 竞态（task_started 与 hook 无序）修复时机~~ | **已修复（2026-08-15，P1 第一项）**：PermissionRequest hook 查 `startedBackgroundTasks` 未命中时，有界等待注册（`waitForBackgroundRegistration`，500ms/25ms 轮询，`background-agent-permission.ts`）；确认前台的 agent_id 进负缓存（`confirmedForegroundAgentIds`），同步 subagent 每个 agent 最多付一次等待。兜底不变：真未注册仍 passthrough → SDK auto-deny（fail-deny 安全侧）。4 个新单测钉死行为 | ~~P1/P2~~ 已执行 |
| ~~D-T4~~ | ~~环境配置（`environments`）的凭据形态~~ | **已定（2026-08-14）：keyPath 为主 + passwordRef 外部引用，自己不保管**——首选只存私钥路径引用（材料不进我们的存储）+ 尊重系统 ssh-agent；密码场景支持 `passwordRef`（Windows Credential Manager 条目 / 环境变量 / 1Password CLI 引用），用时现场取不落盘；环境内凭据（VM 账号、容器服务密码）属研究材料，落工作区笔记，不进配置体系 | P1 |
| ~~D-T5~~ | ~~external runtime（CC/Codex/Gemini）在安全版的去留~~ | **已拍板（2026-08-15，D20）：锁定 builtin 唯一，external runtime 随 P4 减法删除**——边界门控/环境层/蒸馏弧全挂 builtin 链路，external runtime 是纯兼容税；D16 否决「进入其他 harness」后连互操作价值都不成立。runtime list/describe/diagnose 命令族同步收窄，external-session 注入路径随删 | P4 |
| ~~D-T6~~ | ~~「派发想法为任务」入口随想法收集删除后的去留~~ | **已定（2026-08-14）：随删**——thought 全家已删除（thought.rs/management_api 路由/CLI 命令/prompt 注入），任务创建入口走 `zhishi task` 与 task-alignment，不保留想法侧入口 | ~~P4~~ 已执行 |
| ~~D-T7~~ | ~~harness headless / MCP 反向暴露评估~~ | **已取消（2026-08-16，D23）**：调用方不存在，D16 已否决跨 harness 融合/委派，暴露面没有服务对象；真有调用方出现时重新立项 | — |
| ~~D-T8~~ | ~~Tauri 宿主整体退役 → 纯 Node CLI/TUI~~ | **已拍板（2026-08-16，D24）：保留宿主，退役否决。** 盘点（逐项证据见议题 C）：剩余职责 = sidecar 编排 + cron 引擎（task_scheduler）+ PTY + 打包/更新管线，超过退役门槛；平移成本以周计、回归风险实，收益仅审美。减法只做死代码清除（W6 波） | — |

---

## 8. 验证与测试策略（对齐项目测试纪律）

- 每个管线/机制改动先加 characterization test 再动（项目红线）；
- `BUNDLED_TOOL_REGISTRY` 重构（§1.5-1）：纯行为不变重构，跑 `npm run test:unit` + `test:changed` 即可验证；
- 蒸馏弧新增：纯逻辑（prompt 组装/输出解析/计分）抽纯函数进 `unit` 快池（照 `memory/*.unit.test.ts` 先例）；
- SSE 新事件（搭子「场景 × 循环状态」）：过 `sse-whitelist-crosscheck` 三方对账；
- terminal create 参数化：Rust 侧 `cargo test` + Panel API 集成验证；
- 路径/黑名单改动：Node↔Rust 双向对账测试（`path-safety-crosscheck` 先例）。

---

## 9. 一句话总账

- **现成（零新增）**：sidecar 无头载体与 Owner 模型、`zhishi` CLI 通道、PTY/Panel API、插件体系（首批不开放）、skills 播种链路、任务/定时系统、权限双闸骨架、蒸馏管线骨架。
- **扩展（改动小、先例足）**：CLI → `zhishi agent` loop、蒸馏弧 → 安全轨迹弧、system prompt → 安全语境注入、哨兵管线 → 统一注册表、terminal create → 参数化、浏览器 → CDP 驱动系统浏览器。
- **净新增（P1 主要工作量，均已落地，见 §11 议题 A）**：`zhishi agent` 入口、环境层（引擎 bootstrap + 环境类型 + env 标记权限锚点）、research_events 结构化成败信号、协作面（探测注入 + 首批 skills）。**宿主工具链打包已取消**（工具链在环境类型里，§1.1）。
- **最大风险**：~~P4 的 IM 后端切除~~ 已落地（见 §10，4.25 万行删除，验证绿）；~~Rust 侧 cargo 补验~~ 已完成（见 §10.2，check/clippy/test 全绿）。
- **决策状态**：D1–D31 全部拍板（D22 环境直连真实 VM、D23 D-T7 取消、D24 Tauri 宿主保留、D25 废弃 Claude Agent SDK、D26 loop 底座 pi、D27 无本地工作区、D28 自动发现本机环境、D29 情报降级横切层、D30 实战定位 CTF 补充、D31 统一接入管线作废；D-T1–D-T8 全结，见 §7）。

---

## 10. 减法执行记录（2026-08-14，P4 前半已落地）

> 拍板「先删除所有不需要的代码，做好减法再沟通」后，按 §6 工作量地图分 4 波执行完毕。全部改动 **unstaged 未提交**（用户自行 `git diff` 审查；可逆性走 git 历史），全程无 commit/branch/reset。

### 10.1 各波次实况

| 波次 | 内容 | 规模 | 状态 |
|---|---|---|---|
| W1a | bundled-skills 13→7（删 docx/pdf/pptx/xlsx/capability-forge/skill-creator），SYSTEM_SKILLS_VERSION 28→29 | 6 目录 | ✅ |
| W1b | **删 `src/renderer/` 整目录**（562 文件）+ Tauri 无窗口化（lib.rs -424 行不建窗口、pet.rs -283 行、托盘保留、frontendDist 指 placeholder 占位页）+ 前端基建清除（vite/tailwind/tsconfig paths/eslint react 规则/40+ npm 依赖，lockfile -9069 行/CI 去 test:dom） | ~10w+ 行 | ✅ |
| W2 | **删 IM 全家**：`src-tauri/src/im/`（2.2w 行）+ inbox（双侧）+ `plugin-bridge/`（1.7w 行，.zsp `plugins/` 零误伤）+ im 工具三件套 + CLI im/session send/agent channel/OpenClaw plugin 命令族；7 条耦合暗线全处理（SessionCronContext 捞出保留、scenario 收窄 desktop\|cron、task IM 投递管线拆除、Cargo.toml 删 4 crate） | 443 文件 / ~4.25w 行 | ✅ |
| W3a | 需求单全链路（admin-api 4 handler + webhook + 路由 + CLI + `supportUserToken` 字段） | ~1.5k 行 | ✅ |
| W3b | LLM preset 16→2（留 anthropic-api/deepseek；3 搜索 preset 保留；provider-probe/verify 经引用面调查保留）；删 gemini-image/edge-tts；删技能安装管线（`src/server/skills/` 整目录，插件依赖的 fetch 助手迁移为 `plugins/tarball-fetcher.ts` 自包含）；CLI skill 只留 list/info/remove/enable/disable | ~3k 行 | ✅ |
| W3c | 删 thought 全家（thought.rs 1269 行 + management_api 路由 + CLI + prompt 注入）；**pet.rs 整删**（694 行，顺带消除了 W1 后 `pet_pos_path()` 缺失导致的存量 Rust 编译错误）；清 IM 死命令（wecom_qr/bot_workspace） | ~3.5k 行 | ✅ |
| W4 | 清扫验证 + 摘除 builtin-media 死链（builtinMediaResult.ts/builtin-media-attachments.ts/2 处调用点——唯一消费者就是已删的两个工具，codex 附件走 `runtimes/codex.ts` 独立路径不受影响）+ CLAUDE.md/AGENTS.md 同步 + 本节 | ~700 行 | ✅ |
| W5 | **D20 落地：删 external runtime 全家**——`src/server/runtimes/` 整目录（external-session/claude-code/codex/gemini/factory + 策略/缓存/附件等 28 文件）+ 3 个关联测试；共用件先迁移（`utils/env-utils.ts` 供环境层、`utils/kill-with-escalation.ts`、`ImagePayload` → `shared/types/image.ts`）；index.ts 摘除全部 external 分支与 `/api/runtime/*`、`/chat/external-retry`、`/hook/session-start` 端点；admin-api 删 runtime list/describe/diagnose handler + task override 前置校验；标题生成收敛为 builtin SDK 路径；CLI 删 `runtime` 命令族 + `--runtime/--permissionMode/--runtimeConfig/--clearRuntimeOverride`（保留 `--model`），CLI_VERSION 34→35、SYSTEM_SKILLS_VERSION 31→32；SSE 优先级表删 3 个 external 专属事件 | 31 文件删除 / ~1.95w 行 | ✅ |
| W6 | **D24 落地：Tauri 宿主死代码清除**（宿主保留，只清死代码）——lib.rs ~150 个无消费方 invoke command 注册整段删除；browser.rs（1256 行，无父窗口运行期必死）/ search（tantivy 3522 行）/ sse_proxy（1064）/ global_shortcut / attachment_protocol / webview2_check / macos 窗框×2 / config_io 整删；workspace_files 裁到只剩 path_safety；commands.rs 3082→1097（只留三个 seed + validate_file_path）；panel_api 删 5 条 /browser 路由；tray 裁到 exit + show_main_window；断链清除（admin-api `/api/plugin/*` 调用 + cmd_sync_cli）；TS 侧 `zhishi browser` 命令组删除；Cargo.toml 删 tantivy/objc2 全家/webview2-com/tauri-plugin×6 等 16 crate。**收尾二轮**：清死 cmd 包装函数（sidecar -853 / updater -391 / task -355 / terminal -84 / notification -27），clippy dead_code 清零 | ~1.93w 行 | ✅ |

### 10.2 验证状态

- **W1–W4（2026-08-14）**：`npm run typecheck` 0 错误；`npm run test:unit` 630 通过 / 6 skipped / 0 失败；`npx eslint src/server src/shared src/cli` 0 错误。cargo（1.91.0 / stable-x86_64-pc-windows-msvc）：`cargo check` 通过；`cargo clippy --all-targets` 0 错误（10 个既有风格警告均在测试代码）；`cargo test` 303 通过 / 0 失败 + doc-tests 1 通过 4 ignored。`Cargo.lock` 已 regenerate（-230 行）。
- **W5（2026-08-15，D20 external runtime 删除）**：`npm run typecheck` 0 错误；`npm run test:unit` 1216 通过 / 6 skipped / 0 失败（80 文件，含 sse-whitelist-crosscheck 绿）；`npx eslint src/server src/shared src/cli` 0 错误；`cd src-tauri && cargo check` 通过（仅 commands.rs 两个版本号 bump，无逻辑改动）。
- **环境注意**：`cargo check` 前需先有 `binaries/zhishi-updater-x86_64-pc-windows-msvc.exe`（tauri_build 校验 externalBin 存在性）——用 `cargo build -p zhishi-updater` 后拷入即可；该文件 gitignore，不入库。
- 已知非本次引入问题：`terminator/` vendored 子项目 349 个既有 eslint 错误使整库 `npm run lint` 红灯（scoped lint 绿），需主仓库层面决定 ignore 或修。

### 10.3 语义变化备忘（有意的行为变更）

- CLI `skill list` 只列用户级 `~/.zhishi/skills/`（CLI 无 workspace 上下文，项目级枚举取消）；
- 旧 config.json 的 `agents[].channels`/`imBotConfigs`/`supportUserToken` 等 key 被静默忽略（serde/TS 类型不报错），老用户磁盘数据（thought 存储等）代码删除、数据留盘；
- `source_thought_id` 字段保留为惰性 provenance（task 磁盘格式不变，行为联动已拆）；
- `InteractionScenario` 收窄为 `desktop|cron`，`SessionSource` 收窄为 `'desktop'`，`SessionOwnerKind` 收窄为 `'owned'`；
- `browser.rs` 嵌入式浏览器在无父窗口形态下调用即运行期失败（允许不可达，CDP 驱动系统浏览器方案见 §1.6）。
- **W5（D20）**：存量 config.json 的 `agents[].runtime` / `runtimeConfig`、task 的 `runtime` / `permissionMode` / `runtimeConfig` override 字段一律静默忽略——serde/TS 类型不报错、不迁移、数据留盘，`agent set runtime` / `agent show` 仍可读写这些字段（展示存量值）但运行时不再消费；存量 external runtime 会话（meta.runtime ≠ builtin）不 resume、按新会话重建；任务级 override 只剩 `--model` 生效（builtin 模型），admin-api 不再对 override 做前置校验。

### 10.4 后续议题（已拍板待排期）

~~D-T7（headless/MCP 反向暴露评估）~~——**D23 拍板取消（2026-08-16）**：调用方不存在，D16 已否决跨 harness 融合/委派，暴露面没有服务对象。~~D-T8（Tauri 退役）~~——**D24 拍板保留宿主（2026-08-16）**，退役否决，减法只做死代码清除。两者见 §7。

---

## 11. 下一轮沟通议程（待聊清单，2026-08-14 记录）

> 减法收尾后与用户的下一轮对齐议程。每条记录**当前倾向**（讨论中已形成但未经用户拍板的判断）与**待拍问题**。拍板后转为 D-Tx 决策移入 §7。

### 议题 A：P1 开工顺序（环境层优先）✅ 已执行完毕（2026-08-15）

- **执行实况**：~~① cargo 补验~~ → ~~② D-T3 竞态修复~~（有界等待 + 前台负缓存）→ ~~③ 环境层~~（E1 引擎探测 / E2 term 参数化 / E3 配置管理 / E4 配方框架 / E5 dev·pwn·fuzz 配方 / E6 env 标记 + 边界门控）→ ~~④ 全屏 TUI~~（T1 手写 ANSI 地基 / T2 会话接入 / T3 边界确认 / T4 环境选择器首屏 / T5 全局状态区）→ ~~⑤ 语境注入 + 首批 skills~~（S1 五段注入 + S2 四 skills）→ ~~⑥ 蒸馏闭环~~（D1 research_events / D2 安全 kinds / D3 安全蒸馏弧 / D4 反哺注入）→ ~~⑦ 内置 subagent~~（A1 fuzz-runner / crash-triager）。全部 18 项一次落地，验证：unit 1074 绿 / typecheck 绿 / cargo 321 绿。
- **遗留（不阻塞）**：~~E1b 环境引擎自动安装引导~~（已落地：docker 下载+Authenticode 验签+启动安装器、hyperv 走 dism 提权启用；UAC/重启是 Windows 硬约束，半自动即终态，2026-08-16 评估不追加投资）；~~T3 的 `ask-user-question` 结构化应答~~（C2 已做）；~~`/chat/queue/force` 接线~~（C3 已做）；term open --cmd 的端到端冒烟需完整 App；CLAUDE.md 目录清单补 bundled-environments/bundled-agents；cargo test 有 1 个偶发失败未捕获名字（3 次全量输出复跑均 321 绿，判断为既有 flaky 测试，与 P1 改动无关，待定位）。

### 议题 A 续：VM 驱动（vmrun）✅ 已执行完毕（2026-08-15，用户拍板从 P2 提前）

> 背景：用户主力机只有 VMware Workstation Pro（无 Docker）。P1 探测层已认 vmware（`vmrun list`），但生命周期只有 docker 一条路——VM 驱动提前开工。

- **执行实况（V1-V5）**：
  - **V1** `src/server/environment/vm-lifecycle.ts`：vmrun 生命周期驱动（结构照 docker-lifecycle：命令组装/输出解析纯函数 + 可注入 exec）。up = 整目录拷贝模板 VM（`~/.zhishi/vm-instances/zhishi-<recipe>-<shortid>/`，改写 displayName，模板只读）→ 声明快照存在则 revertToSnapshot（快照约定 = 每次 up 都是干净现场）→ `vmrun -T ws start nogui` → `getGuestIPAddress -wait` 取地址（失败不阻断 up，地址缺省由 open 时报错兜底）；down = stop soft（**实例目录保留**，VM 状态可续，删除是显式手动操作）；ps = vmrun list ∩ instancesRoot。
  - **V2** 配方 frontmatter 扩 `vm_base` / `vm_user` / `vm_snapshot`（均可选；vm_base 也可由 `env up --vm-base` 现场给——模板是机器私有资产，不进随包配方）。
  - **V3** 接线：admin-api `environment/up` 按 `recipe.base` 路由；VM up 拿到地址后**自动回写 env 条目**（kind: vm，vmName/address/user/keyPath）——`env open` 与首屏选择器立即可用（访客通道 = 既有 SSH 路径，§1 议题 D「SSH 用于联网 VM，断网隔离 VM 走 guest-exec」的联网半边；guest-exec 仍属后续）。`environment/down` 按 vmx 后缀 / vm-instances 目录命中路由 VM，否则 docker；`environment/ps` 双引擎合集（单侧缺席不拖垮另一侧，带 driver 字段）。CLI：`env up --vm-base/--user/--key-path` 透传 + 输出打印 address/vmx。
  - **V4** 首个 VM 配方 `bundled-environments/pwn-vm`（base: vm，vm_user/vm_snapshot 约定，setup.sh 首启 guest 内初始化 + 自检后做 `zhishi-clean 快照的收尾约定`）；`ENVIRONMENT_RECIPES_VERSION` bump 1→2。
  - **V5** 验证：unit 1104 绿（新增 30）/ typecheck 绿 / cargo 复跑。
- **设计取舍**：模板 VM 由人准备（「只有人可以建立环境」的产品红线延伸到模板——agent 不建 VM）；取不到 IP 不算 up 失败（实例已在跑，open 时给未配置 address 的清晰报错）；v1 不做 guest 内 setup.sh 自动执行（需凭据 UX，SKILL.md 约定首启手动跑 + 做快照）。
- **遗留（不阻塞）**：断网隔离 VM 的 guest-exec 通道（vmrun runProgramInGuest / VMBus / qemu-ga，§1 议题 D 的另半边）；~~guest 内 setup.sh 自动执行 + 自动做快照~~（V6 adopt 已闭环）；Hyper-V/VirtualBox/libvirt 驱动（探测已认，生命周期只做了 vmware）；实例目录删除命令（当前手动）。

### 议题 A 续二：模板自动养成 `env adopt` ✅ 已执行完毕（2026-08-15，用户拍板）

> 背景：用户质疑「为什么要人建模板？为什么不能自动？」——拦的是 agent（D17），从来不拦自动化。两条自动化路径拍板：**有 VM 已有系统 → adopt（先做）**；什么都没有 → ISO 无人值守 build（随后，见遗留）。

- **执行实况（V6a-V6c）**：
  - **V6a** `src/server/environment/vm-adopt.ts`：认领编排（结构同前：纯函数 + 可注入 exec，18 测）。流程 = 校验/启动 VM → 拿地址（getGuestIPAddress；**DHCP 租约文件 MAC 反查兜底**——`C:\ProgramData\VMware\vmnetdhcp.leases`，guest 零配合）→ 连通（公钥 BatchMode 探测 → 不通则 plink 密码通道，密码 CLI 现场隐藏输入、POST 瞬传、绝不落盘，D-T4 不破）→ guest 初始化（apt 系：ensure openssh-server/open-vm-tools + 建 researcher NOPASSWD sudo + 写公钥）→ 跑配方 setup.sh → 关机（ssh poweroff，vmrun stop soft 兜底）→ `zhishi-clean` 快照 → 模板落 `config.json::vmTemplates`。
  - **V6b** admin-api `environment/adopt` 路由 + `vmTemplates` 持久化（`AdminAppConfig` + shared config-types 同步加字段）；`environment/up` 的 vmBase 解析顺序定为 **--vm-base > vmTemplates > frontmatter vm_base**（adopt 产出已验证已供应，优先于静态声明）；回写 env 条目的 user/keyPath 同步从模板回落。
  - **V6c** CLI `zhishi env adopt <recipe> --vm <vmx> [--user] [--key-path]`；密码**不走 flag**（防 shell 历史泄漏）——server 报「公钥登录不通」时 CLI 现场隐藏输入后带 password 重试一次。
- **自动化地板**：guest 至少有 sshd 或 VMware Tools 之一（两条远程通道皆无的裸 VM 只剩模拟键盘，不做）；v1 仅 apt 系 guest。
- **遗留（不阻塞）**：`template build`（ISO + autoinstall 无人值守，从零造模板；含纯 TS ISO9660 seed 生成器）；sudo 密码经进程参数瞬现（本机单用户可接受，文档已声明）。
- **实测修复（2026-08-15 全流程实测，机器：Workstation 17.6.2 @ D:\vm\ 自定义路径）**：①vmrun 不在 PATH 时探测误报——新增 `vmrun-path.ts` 注册表 InstallPath 兜底（WOW6432Node/原生双 hive），engines/vm-lifecycle/vm-adopt 三个 exec 点全接；②挂起态残留 VM 的 `start nogui` 首试报「未知错误」重试即成——两处 start 均加失败重试一次；③SSH 探测失败分类（transport/auth）——kex 前被重置（guest sshd 坏/没起）直接给 guest 侧修复指引，不再误入密码通道；④plink 缺失自动下载（PuTTY 官方直链 → `~/.zhishi/bin/plink.exe`，Authenticode 验 Status=Valid + 签发者 Simon Tatham，不过即删——D-T2 分层信任根）。

### 议题 A 续四：自动发现本机环境（D28）—— ✅ 已执行完毕（2026-08-17）

> **执行实况**：`POST /environment/discover` 只读端点落地（docker 全量含已退出 + VMware/Hyper-V/VirtualBox 全量，`managed` 标记去重）；gate 正门「本机已有（未注册）」分组消费，选中即 `environment/add` + `select`（仅选定落盘，D28 约束①）。随 TUI 重做一波（`8888f96`）进的生产路径，TUI 活体验证通过。

> 背景（2026-08-16 用户拍板）：gate 首屏应自动列出宿主机已有 VM / docker 容器，用户不必先 `env add`。强需求。设计约束见 design §11 D28。

- **新增端点 `POST /environment/discover`**（只读，不写配置）：
  - **docker 发现**：复用 `docker-lifecycle.ts` 的扫描，但**去掉 `label=zhishi.env` 硬过滤**，改为 `docker ps -a --format ...`（含已退出）；每条带回 `id/name/image/state/label(若有 zhishi.env)`，`zhishi.env` 标签存在者标 `managed:true` 以便 gate 去重。
  - **VM 发现**：复用 `vmEnvPs / hypervEnvPs / vboxEnvPs` 的扫描逻辑，但**去掉「手动起的不归 zhishi 管」的排除**——`vmrun list`（含 running+suspended）、`Get-VM`、`VBoxManage list runningvms` 全量返回，带 `driver` 字段。
  - 返回结构：`{ success, data: { docker: [...], vm: [...] } }`（两个数组各自为空时降级为空，不抛错；单侧引擎缺席走 `safe()` 降级）。
  - **不调用 `saveConfig` / `atomicModifyConfig`**——严格只读，绝不污染 `config.json`（D28 约束①）。
- **选中即注册（D28 约束②）**：gate 选中发现项时，按 `discovered.kind`（`docker`/`vm`/`ssh`）自动构造 `environment/add` 参数再 `environment/select`+（vm/docker 视情况）`environment/up`；仅本次选定落盘，不自动全量注册。
- **数据源接入**：`gate.ts` 的 `gatherGateData` 新增一路 `discover`（并行 `list/ps/recipes/engines/discover`），discover 失败不影响其它分组（沿用 `safe()` 降级）；`buildGateOptions` 新增「本机已有」分组，发现项标 `⚡未注册` 角标；已注册环境（命中 `config.environments` 的 vmx/id）从发现列表去重剔除。
- **不破坏既有契约（D28 约束③）**：`environment/list`（只读 config）、`environment/ps`（实例展示，docker 仍按 `label=zhishi.env` 过滤只显示 zhishi 管的）行为**不变**；discover 是新增并行的只读源。
- **呈现（D28 docker 决策）**：docker 全量列出含已退出，由用户在 gate 内搜索挑选，不过滤噪声。
- **测试**：新增 `discover` 单测（mock exec 返回 fixtures，断言 docker 全量 + VM 全量 + 单侧缺席降级 + 不写配置）；gate 集成测试补「本机已有」分组渲染与选中即注册路径（虚拟 admin client）。

### 议题 A 续三：VM 链路收尾 + 配方扩容 ✅ 已执行完毕（2026-08-15）

> 用户拍板「A2 先不测，其他按顺序落地」。A3/A4 实测 + B1-B5 + D1/D2 一次落地。

- **A3 生命周期实测（真实机）**：迷你无盘模板（vdiskmanager 1GB，避开 fuzz VM 几十 G 拷贝）跑通 `env up`（拷贝→nogui 启动→取 IP 超时按设计不阻断）→ `env ps`（driver=vm 正确列出）→ `env down`（无 OS guest 的 soft stop 超时，错误文案正确引导 hard）→ `env rm`。附加发现并修复：手搓 vmx 缺字段集（config.version/pciBridge/vmci0 等）会报「无法读取虚拟机的配置文件」——已知可用字段集固化进 vm-build 的 vmx 生成器。
- **A4 构建产物修复**：CLI esbuild 产物是 CJS 但 .js 后缀，在 type:module 仓库里直接跑必炸（require undefined）——postBuild 现在写 `resources/cli/package.json`（type:commonjs）。非 TTY 提示行为验证正常（手感实测留用户真终端）。
- **B1 `env build`**：从零造模板——`iso9660.ts` 纯函数 ISO9660+Joliet 生成器（NoCloud 的 cidata/user-data 小写连字符约束靠 Joliet SVD 满足）+ Ubuntu Server ISO（releases.ubuntu.com，SHA256SUMS 校验，~/.zhishi/iso 缓存）+ autoinstall user-data（researcher + 密钥登录 + NOPASSWD sudo + openssh-server/open-vm-tools，密码锁死）+ vdiskmanager 建盘 + vmx 生成 → nogui 启动 → 轮询 SSH 至通（45min deadline）→ setup.sh → poweroff → 快照 → 落 vmTemplates。**未实机验证**（2.6GB 下载 + 实装 20-40 分钟），建议狗食时跑一次。
- **B2 `env exec`（guest-exec 通道）**：断网隔离 VM 的一次性命令——`runProgramInGuest` 包 `/bin/bash -c '( cmd ) > out 2>&1; echo $? > code'`，`copyFileFromGuest` 取回输出与退出码，`deleteFileInGuest` 清理；guest 命令非零 ≠ 通道失败（exitCode 原样带回）；认证/Tools/未运行三类失败有各自指引；guest 密码现场输入不落盘（vmrun 只认密码，D-T4 的 keyPath 救不了这条通道，文档已声明）。恶意样本 detonate 的隔离通道自此打通（§1 议题 D 的另半边兑现）。Windows guest 报「后续版本」（v1 仅 Linux /bin/bash 包装）。
- **B3 Hyper-V/VirtualBox 双驱动**：frontmatter 新增 `vm_engine`（缺省 vmware）。Hyper-V 模板 = Export-VM 导出目录（Import-VM -Copy -GenerateNewId 克隆成实例，落点 `~/.zhishi/vm-instances-hyperv/`）；VBox 模板 = 已注册 VM 名（clonevm --register 全克隆）。up/down/ps/rm 四操作三驱动对齐（取 IP 语义一致：轮询、超时不阻断 up）；`env ps` 四源合集带 driver 列；down/rm 路由 vmware 目录 → hyperv → vbox → docker 固定优先级。`vboxmanage-path.ts` 注册表兜底照 vmrun-path 模式。adopt/build 自动养成模板**仅 vmware**（其他引擎模板现场给，报错有明确引导）。**未实机验证**（本机无 VBox、Hyper-V 无现成 VM）。
- **B4 `env rm`**：删已停止 VM 实例目录（instancesRoot 前缀防逃逸 + 运行中拒绝），已实测。
- **B5 SSH --port**：EnvironmentEntry.port（1-65535），ssh 与 vm-with-address 的 open 命令组装 `-p`。
- **D1/D2 配方扩容**：`fuzz-vm`（docker fuzz 的 VM 版，AFL++ 全家，scp 进出语料——VM 隔离无工作区挂载是本意）+ `rev`（docker，Ghidra 12.1.2 headless 按需下载，**sha256 钉死校验**（官方公布值），补丁 diff 套路写进 SKILL.md）。
- **验证**：unit 1257 绿 / typecheck 0 错 / cargo 三连跑全 exit 0（flaky 测试未复现，留观察）。

### 议题 B：全屏 TUI（2026-08-14 二次拍板：上全屏 TUI，做好 → D15）

> 拍板过程：先定「操纵台最小化、不需要 TUI」→ 讨论跨 harness 关系时否决任务委派模型（黑盒、调用方中途无法控制，→ D16）→ 控制成为产品刚需 → 多现场并发下的全局可见性必须常驻 → **二次拍板：上全屏 TUI，把 TUI 做好**。

- **定位**：harness 本体价值不变（循环机制是产品，界面是控制面不是价值面），但**界面是控制的载体，控制是刚需**——控制四要素：看得见/插得进/停得下/批得准。其中「看得见」在多现场并发（fuzz 长跑 + exploit 迭代 + 情报监听并存）下必须常驻全局视图，REPL + 命令轮询不成立。
- **形态**：全屏 TUI = **环境选择器（会话首屏，D17：第一步强制人选环境）** + 主交互流（渲染/流式/输入输出分离/Esc 中断/边界确认）+ **常驻全局状态区**（并发 loop/环境/任务一览，搭子「场景 × 循环状态」的落点）。输入悬挂重绘层仍是地基。
- **打磨标准**：回到 D13 原话——**等同于别人的 GUI 设计**。磨的是控制可操作性，不是视觉花哨；手感对照基线 = kimi-code / Claude Code / Codex CLI（研究员已在用，界面基线已被它们设定）。
- **技术已定（2026-08-17，TUI 重做 W0–W4 闭环）**：渲染栈 = **自研 mini-renderer**（`src/cli/tui/v2/`：style/row-buffer/viewport/frame-scheduler/terminal-writer，脏行 diff + pinned chrome）——Ink 类方案被否（无模式回看/折叠块/optimistic 插入是其弱区，且零新增依赖低维护）。全链路真机验证 13/13 通过，方案与落地校准见 `docs/tui-rebuild-plan.md`。
- **可逆性**：TUI 属 CLI 形态，与 D13「删除 GUI」不冲突；D13 已定死不做 GUI（2026-08-15），证伪信号触发 TUI 重做而非 GUI 回归。

### 议题 C：Tauri 宿主整体退役评估（D-T8）——**已拍板（D24，2026-08-16）：保留宿主，退役否决**

- **拍板结论**：盘点后宿主剩余职责 = sidecar 编排（5.5k 行）+ cron 引擎（task_scheduler 3.3k 行）+ PTY + 打包/更新管线——超过「只剩拉进程+打包」的退役门槛；平移成本以周计、回归风险实（cron 语义、Windows 进程卫生），收益仅单一语言审美、功能零变化，不对等。**减法只做死代码清除（W6 波）**。远期若宿主职责自然收敛到门槛内可重提。
- **盘点结果（2026-08-15/16，模块级实况）**：
  - **可直接删除（约 Rust 一半，净收益）**：workspace_files（21 文件）、search（tantivy 7 文件）、sse_proxy（1064 行）、browser（1256 行，若接受 CDP 替代）、tray/global_shortcut/i18n/attachment_protocol/webview2 等杂项、~100 个死命令注册（GUI 删后 Node 侧零 invoke）。Cargo 依赖 10 个 tauri-plugin + wry 全链可砍。
  - **保留的活能力**：①terminal PTY（panel_api/terminal.rs，`zhishi term` 的 ConPTY 承载）；②task store+scheduler+wake_lock（cron 引擎）；③sidecar.rs 编排；④management_api；⑤notification（cron 完成通知）；⑥updater/usb_updater + 打包签名管线。
  - **附带发现**：①`cmd_sync_cli` 在 GUI 删后已无人触发，CLI 脚本同步链路现状存疑，W6 一并处理；②admin-api.ts:4002-4034 调 managementApi 的 `/api/plugin/*`，但 management_api.rs 路由表没有 plugin 路由——**已断的活路径**（404），W6 一并清。

### 议题 D：headless / MCP 反向暴露（D-T7）——**已取消（D23，2026-08-16）**

- **取消拍板**：调用方不存在，D16 已否决跨 harness 融合/委派，暴露面没有服务对象；真有调用方出现时重新立项。评估报告保留在下文存档。
- **当前倾向**：主体必须是自己的 harness（交互、审批、会话、环境全在手），headless 是**第二形态**不是主形态；同一 harness 两个前端（CLI/TUI + MCP endpoint），成本是多一个适配层不是翻倍。暴露策略：分层暴露（先环境工具层，核心编排不外流）+ headless 默认「越界即拒」（D14 边界模型下无审批穿透问题）+ 按 API 产品管理（鉴权/配额/审计）。
- **待拍问题**：六类风险清单（§7 D-T7）逐条过；先暴露到哪一层；启动时机（P1 环境层定型后）。**注意**：此项依赖议题 A 的环境层先落地，纯评估可以提前做。
- **已否决方向（2026-08-14，→ D16）**：任务级委派（`zhishi agent -p` 作为其他 harness 的调用入口）——黑盒执行、调用方中途无法控制，明确不接受；插件形态进入其他 harness 同否（只能交付内容层，loop 与蒸馏弧价值尽失）。跨 harness 关系定为「不融合、不委派，各自独立运转，共享工作区即协作面」。本议题剩余范围随之收窄：D-T7 评估的是 harness 对**程序化调用方**的暴露，不再承担「与其他 agent harness 互通」的使命。
- **评估报告（2026-08-15，基于环境层已定型 + guest-exec 已通的现状）**——六类风险逐条：
  1. **安全边界**：✅ 已自解。D14 边界模型 + E6 门控（env≠host 界内全自动、跨界默认拒绝）+ B2 guest-exec（隔离 VM 不联网也能操作）——headless 调用方拿到的只是「环境内执行权」，宿主机无暴露面。**注入面**（调用方 prompt 不可信）由「环境即沙箱」兜底：就算被注入，破坏半径 = 一次性环境。
  2. **资源滥用**：⚠️ 真空。环境是真算力（fuzz 长跑小时级），headless 暴露必须带鉴权/配额/限速——当前 admin API 只绑 127.0.0.1 无任何鉴权，**暴露前必须先做这一层**（本机 loopback 场景可以先不做，跨机暴露时成为硬前置）。
  3. **依赖倒置**：⚠️ 可控。只暴露稳定面（env/recipes/research log 这些 CLI 已稳定的命令面），编排内部（loop/蒸馏）不暴露——CLI 命令面本身已是半公开契约（zhishi-cli SKILL.md 在教它），边际成本低。
  4. **责任归属**：✅ 可解。trace/research_events 记环境侧全程（D1-D4 已落地），审计材料现成；跨机暴露时需要加调用方身份字段进 research_events（小改）。
  5. **价值外溢被复制**：✅ 分层解决。先暴露环境工具层（env up/down/exec + research log——「环境即服务」），核心编排（蒸馏弧/语境注入）不暴露。环境层恰好是消耗①（可能力化外溢），编排是消耗②③（不外流）。
  6. **技术错配**：⚠️ 真实存在。MCP 请求/响应模型装不下小时级 fuzz 任务——若做 MCP 暴露，任务面必须走「提交-轮询/通知」异步模型（CronTask 已有先例），不能假装同步调用。
  - **结论建议**：本机 loopback 场景的「环境即服务」暴露（env 族 + research log，经 admin API/MCP）**可以排期**（风险 1/4/5 已解，3 成本低，2/6 在 loopback 不成立）；**跨机暴露暂缓**（2 的鉴权配额层是硬前置，且当前没有跨机调用方需求）。

### 议题 E：external runtime 去留（D-T5）——**已拍板（D20，2026-08-15）**

- **拍板结论：锁定 builtin 唯一，external runtime（CC/Codex/Gemini CLI）随 P4 减法删除**，runtime list/describe/diagnose 命令族同步收窄，external-session 注入路径随删。与 D-T7 不合并（headless 暴露的是我们自己的 harness 命令面，external runtime 是别人的 loop，两回事）。可逆性由 git 历史兜底。
- 拍板依据：P1/P2 落地后，边界门控（E6）、环境层（E1-E6 + VM 三驱动）、蒸馏弧（D1-D4）全部只挂在 builtin 链路——external runtime 一条都用不上，已是不折不扣的兼容税；D16 已否决「进入其他 harness」，external runtime 连互操作价值都不成立（互操作面 = 共享工作区，不是 runtime 复用）。

### 议题 F：分工与节奏——**已拍板（D21，2026-08-15）**

- **第一个 dogfood 场景 = CTF pwn 题**：闭环最短、可重复（pwn 环境 → 分析 binary → 写 exploit → 迭代打通），一把同时验 A2 adopt、B 组实机冒烟（B1 build / B2 guest-exec / B3 双驱动）、TUI 手感、蒸馏闭环。**第二个 = CVE 复现**（更重，验环境供应广度）。
- **TUI 证伪标准**：dogfood 中控制四要素（看得见/插得进/停得下/批得准）有任一要素在 TUI 里反复做不到、被迫绕出产品用外部工具完成核心 loop ≥2 次，或研究员明确表示现有 TUI 不可用——即触发 **TUI 交互形态的重做**（D13 已定死不做 GUI，证伪指向 TUI 打磨方向修正，不指向 GUI 回归）。
- **分工**：代码/文档/测试由 agent 扛；实机冒烟（密码输入、ISO 下载、网络修复、VM 操作确认）由用户扛；dogfood 由用户以目标研究员身份主导，agent 辅助。
- **✅ dogfood #1 完成（2026-08-16，ret2win）**：自研 pi 引擎 + pwn-vm 直连环境，agent 全程自主打通（写 vuln.c → gcc 无保护编译 → checksec → cyclic+core 定偏移 72 → 识别 movaps 栈对齐坑垫 ret gadget → 拿 flag），独立复核属实（文件/flag/repro 一致）。**五个发现当日全部闭环**：①状态区现场 tag 硬编码 docker（按 environment/ps driver 渲染，`5b9d83c`）②pi 引擎语境注入缺席（五段/蒸馏未接入，agent 全程零留痕；接入 buildSystemPromptAppend，`faa46fa`）③研究留痕落地通道不存在（agent 在环境干活、CLI 在宿主；research_log harness 原生工具，`501c995`）④教学模板超 500 字硬顶被截尾⑤**上下文先例惯性**——换工具后旧会话「我做不到」的先例会让模型跟先例不走新工具（行为观察；`/chat/reset` 命令补齐，`a50ba49`）。research_events #1–#3 落库，蒸馏弧第一环在新引擎上成活。**TUI 证伪标准未触发**（四要素无 ≥2 次失效）。

### 议题 G：VM 直连改造 + A2 实机验收（D22/D23）——✅ 已执行完毕（2026-08-16）

- **D22 直连改造**：废弃模板整目录拷贝派生（起因：模板 114G，无分区容得下拷贝；用户指出模板/派生对多系统场景是 doubling）。`vm-lifecycle.ts` 重写为直连语义（up = revert+start 零拷贝幂等、down = 停机、rm = 只摘登记绝不动用户文件、ps = vmrun list ∩ 登记条目）；`EnvironmentEntry` 加 `vmx` 定位锚；hyperv/vbox 驱动不动。unit 1214 绿 / typecheck 绿 / eslint 绿。
- **D23**：D-T7（headless/MCP 反向暴露）取消——调用方不存在。
- **A2 实机验收通过**：adopt（fuzz.vmx → vmTemplates + zhishi-clean 快照）→ env up 直连 → env ps → SSH researcher 公钥 → gdb/pwntools/ROPgadget 全绿。
- **实测修掉的 8 个真 bug**（全部钉了注释/测试）：①CLI 密码提示语被隐藏回显吞掉（rl.question 的 query 走被置空的 _writeToOutput）②plink host key 缓存与 OpenSSH known_hosts 不通用，-batch 即拒连（ssh-keyscan 取指纹 + `-hostkey` 钉住）③plink 多指纹逗号/分号拼接只认第一个（每指纹一条 `-hostkey` flag）④provision 数据管道过 `echo pw | sudo -S` 丢数据（prime 一次后全 sudo -n）⑤useradd 锁定账号 sshd 拒一切登录（usermod -p '*'）⑥pip 大 wheel 官方源读超时（--timeout/--retries + 清华镜像回退）⑦非交互 ssh 的 PATH 缺 ~/.local/bin（setup.sh 头部 export）⑧gem 挂死无界（timeout 120）。另：单测误删真 plink（destPath 注入修复）、CLI 长任务 fetch 用 undici fetch + dispatcher 禁超时（Node 全局 fetch 不收自定义 dispatcher）。
- **配方语义调整**：pwndbg 移出 pwn-vm 模板关键路径（github 直连在部分网络不可用），改为实例内按需补装；SKILL.md 已注明。

### 议题 H：Claude Agent SDK 替代路线（D25）——✅ 已闭环（2026-08-16 硬切完成）

- **拍板（D25，2026-08-16）**：harness 全套自有，Claude Agent SDK 废弃；**允许直接切换，不搞长期双轨**。核心动机（用户定调）：不只是厂商绑定洁癖——**SDK 的工具执行体只在宿主本地跑，与环境层是两张皮**；三大支柱（环境融合/原生工具/原生代码）要深合，loop 必须自有。评估重点 = 底座 + 环境/工具/代码配合；权限不是评估项（D14：边界是规则不是审批）。
- **内部盘点（替代工程量）**：SDK 在扛的大三块 = agent 主循环 + 内置工具执行体（Read/Bash/Edit 等本体都在 claude.exe，我们只有类型壳）+ auto-compact。**已在自手里的**：权限决策全族（边界门控/风险分级/plan 门控纯函数）、SSE 全链路、SessionStore 会话镜像、openai-bridge provider 桥、system-prompt 组装、agents/插件加载器。核心战场 = `agent-session.ts` 16544–20300 行适配面 + 工具执行体从零写。总工程量数月级。
- **开源底座调研（许可证/活跃度已查证）**：**Vercel AI SDK（Apache-2.0，纯库，Anthropic 兼容端点 + 自定义 baseURL 是一等配置）做 provider + loop 原语，harness 层全自研**为推荐路线；**pi（pi-agent-core，MIT，唯一现成的 TS loop 库，beforeToolCall ≌ canUseTool）备选**；OpenCode serve 可作 PoC 捷径；Mastra 太重；Crush(FSL)/Goose(Rust)/Aider(停滞）/Continue（已归档）只抄设计。值得抄：OpenCode 权限规则引擎与事件溯源会话存储、Mastra 审批快照 + fingerprint 防 TOCTOU、Continue 的 Claude Code 兼容 hooks 协议、OpenHands 的 Condenser。
- **spike 验收标准**（用户定调）：不看权限切点，看**工具执行体能否直接挂环境层**（Bash 工具本体在 guest 里执行，不绕 ssh）。AI SDK 与 pi 各做一次接入验证。
- **里程碑草案**：M1 最小 loop（流式 + tool-use + 工具执行体挂环境层）+ 一次性调用（标题/蒸馏/验证）换裸 API → M2 会话持久化/恢复 + 边界规则接入 → M3 subagent + hooks + 安全场景智能压缩 → M4 直接切换删 SDK。
- **✅ 已执行完毕（2026-08-16，D25 闭环）**：M1（`src/server/loop/` 落地 + 首批三处 query 换 pi one-shot）→ M2（loop-sessions 持久化/恢复 + boundary 规则引擎：白名单/env-ready/凭据不泄环境，deny 回注零问人）→ M3（delegate_task 子代理白名单收窄深度限 1、output-guard 出向净化 [redacted]、保守压缩 tool 对存活闭包）→ M4a（sse-adapter 逐字段映射 + ZHISHI_LOOP_ENGINE 并行开关）→ M4b（FIFO 队列/跨重启续跑/rewind/图片/thinking/config 开关）→ **M4c 硬切**：agent-session.ts 21604→578 行，SDK query 主路径/permission:request 体系/openai-bridge/buildClaudeSessionEnv/SDK-ism 全删，`@anthropic-ai/claude-agent-sdk` + 9 平台包依赖移除，默认引擎恒 pi（显式 sdk 告警回落）；**蒸馏弧迁移到 pi turn 完成点**（logGapEvent + 幻觉工具 gap 一类，自动标题同点）；cron 执行走 pi 路径。验证：unit 1323 绿 / typecheck 0 / eslint 0 / cargo check 绿 / 默认引擎活体 12/12。**总账：-2.82 万行，SDK 依赖归零**。
- **遗留（不阻塞）**：~~fork 未实现（501）~~（已实现 2026-08-17：forkLoopSession 复制原语 + forkPiChat 序数映射 + TUI /fork 面板，`c5c8f9b`）；pi 会话不写 SessionStore 消息体（TaskCenter 统计低估）；stop 不中断已发出的 env_exec 进程（abort 只停 LLM 流）；MCP/插件运行时无消费者（配置面保留）；pi 0.x 升级前必须重跑三个 smoke。
- **spike 结果（2026-08-16，双路均 PASS）**：AI SDK 与 pi 都通过验收标准（env_exec 经 SSH 在 guest 执行 uname/hostname/gdb --version，模型回答引用 guest 事实，独立 ssh 复核一致）。**D26 拍板底座 = pi**：loop 开箱即用（tool 调度/并行/事件流/steering 队列/compaction 工具）、`beforeToolCall` 一等公民、内置 kimi-coding provider（端点零配置）、文档扎实；版本钉 0.84.2；AI SDK 留 fallback。AI SDK 侧唯一坑：baseURL 需手动补 `/v1`。
