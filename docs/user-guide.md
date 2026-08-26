# zhishi 使用指南

> 面向研究员的使用手册。从这里开始：安装 → 选环境 → 配模型 → 开始研究。
> 版本：v1.1.5。命令以本文为准；设计细节看 `docs/` 下的技术文档。

---

## 目录

1. [安装与启动](#1-安装与启动)
2. [第一次使用：正门与环境](#2-第一次使用正门与环境)
3. [环境管理](#3-环境管理)
4. [模型配置](#4-模型配置)
5. [GUI 操作](#5-gui-操作)
6. [引擎能力：四个工具](#6-引擎能力四个工具)
7. [情报检索](#7-情报检索)
8. [研究留痕与记忆](#8-研究留痕与记忆)
9. [MCP 服务器](#9-mcp-服务器)
10. [常见问题](#10-常见问题)

---

## 1. 安装与启动

### 发行包（Windows）

- 到 [GitHub Releases](https://github.com/LielingAi/ZhiShi/releases/latest) 下载 `ZhiShi_<版本>_x64-setup.exe`（NSIS）安装，或便携 ZIP 解压即用。
- **安装后 `zhishi` 命令直接可用**（1.2.10 起）：安装器把 CLI 落到 `~/.zhishi/bin` 并注册进用户 PATH——新开一个终端就能敲 `zhishi --version`、`zhishi expert list` 等（已开着的终端要重开才刷新 PATH）。
- **安装后点击桌面图标即打开 GUI 主窗口**；开机自启不会弹窗。托盘的「打开会话」菜单/左键、任务栏再点图标同样聚焦 GUI 窗口（1.3.9 起三入口统一）。
- `zhishi` 命令在应用启动时自动同步到 `~/.zhishi/bin/`。Tauri 壳在后台负责引擎（sidecar）生命周期，无需手动起服务。

### 源码运行（开发态）

要求 Node.js ≥ 22：

```bash
npm install

# 一条命令：Tauri 开发壳（GUI 窗口 + sidecar + vite HMR）
npm run tauri:dev

# 或分开跑——终端 1：sidecar（引擎 + admin API）
node --import tsx/esm src/server/index.ts --agent-dir "$PWD"

# 终端 2：GUI（vite dev server，浏览器/窗口连 sidecar）
npm run dev:gui
```

### 退出

- GUI 是窗口应用：关窗即退出会话视图；托盘「退出」结束后台壳。
- 源码运行时退出 sidecar 进程即可。

---

## 2. 第一次使用：环境侧栏与环境

GUI 打开即见**环境侧栏**——研究只发生在环境里（没有「宿主机模式」）：

- **运行中 / 已停止**：已登记环境，点击切入（已停止会拦截提示先启动）；行尾 ⋯ 菜单有启动/停止/重推能力/详情/删除。
- **本机已有（未注册）**：自动发现宿主机上的 Docker 容器与 VM，登记入侧栏（VM 需补 guest 地址）。
- **新建环境**：「＋ 新建环境」四步向导——docker 配方（一次性容器）/ VM 配方（持久可回滚）/ 接入已有 / 手动 SSH。
- **手动接入 SSH 主机**：host / 用户 / 密钥路径 + 端口/配方绑定（可绑定域）。

**两条铁律**：

1. **创建权在人**——环境只能由人创建/纳管，agent 不会自建环境。
2. **能力跟着现场走**——环境的能力集合由现场推导（装了什么工具就是什么能力），域切换在集合内进行，不随环境类型绑死。

---

## 3. 环境管理

### CLI 命令

```bash
zhishi env recipes                              # 内置环境类型清单
zhishi env up pwn-vm                            # 从环境类型建环境（首次构建需几分钟）
zhishi env adopt pwn-vm --vm <vmx路径> --user <用户>   # 纳管已有 VM
zhishi env list                                 # 已登记环境
zhishi env ps                                   # 运行中实例
```

### GUI 操作

| 操作 | 作用 |
|---|---|
| 环境行点击 | 切到该环境自己的会话线（每环境独立历史，来回切换不串场） |
| ⋯ 菜单 | 启动 / 停止（有损确认）/ 重推能力集合 / 详情（配方绑定管理）/ 删除 |
| `/snapshot [名]` | 给当前环境打快照（干净现场，反复回滚的底气） |
| `/rollback <快照名>` | 回滚到快照 |
| attach 页 | 真终端接管环境 shell（xterm + WS pty）+ 一次性命令执行双模式 |
| `/extract <环境内路径>` | 回收环境内文件到宿主 |

切换环境会**同时切到该环境自己的会话线**（1.1.6：每环境独立历史，来回切换各接各的，不串场；turn 运行中会被拒绝，先 Esc 中断再切）。

VM 类型环境的快照约定：每次 `env up` 回到 `zhishi-clean` 干净快照——环境脏了不用收拾，回滚重来。

---

## 4. 模型配置

内置 **8 家供应商**，填 key 即用，不用配端点：

| 供应商 id | 说明 | 格式 |
|---|---|---|
| `deepseek` | DeepSeek | anthropic 兼容 |
| `kimi` | Kimi（pi 内置通道） | 内置 |
| `openai` | OpenAI | OpenAI |
| `moonshot` | Kimi（Moonshot 开放平台） | OpenAI |
| `dashscope` | 通义千问 | OpenAI |
| `zhipu` | 智谱 GLM | OpenAI |
| `siliconflow` | 硅基流动（聚合平台，可跑 DeepSeek/Qwen 等） | OpenAI |
| `anthropic-api` | Anthropic | anthropic |

### CLI 配置

```bash
zhishi model list                                # 各家状态与模型
zhishi model set-key deepseek <apiKey>           # 保存 key（自动拉取模型列表）
zhishi model verify deepseek                     # 验证 key 可用
zhishi model set-default deepseek deepseek-v4-pro   # 设置默认模型
```

### GUI 配置（不用退出去）

- 状态栏点模型名 → 切换模型（只显示已配置供应商）
- 设置页 → 模型：key 隐藏输入、默认模型、验证
- 主力供应商配额耗尽（如 403）时，另一家已配 key 的供应商随时可切——模型可换，harness 不变。

---

## 5. GUI 操作

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/snapshot [名]` / `/rollback <名>` | 环境快照 / 回滚 |
| `/extract <环境内路径>` | 回收环境内文件到宿主 |
| `/rewind` | 回退到历史消息（改完重发） |
| `/fork` | 从某条消息分叉出新线程 |
| `/queue` | 查看/取消排队消息 |
| `/tasks` | 查看子任务与后台进程（列表 → 点开看 transcript） |
| `/export [sanitize]` | 导出研究报告（report.md + evidence/；`sanitize` 出脱敏版，需一次越界批准） |
| `/reset` | 重置对话（新会话） |
| `/help` | 命令帮助 |

### 快捷键

| 键 | 作用 |
|---|---|
| `Enter` | 发送；turn 进行中发送 = 纠偏注入（不打断，注入下一轮） |
| `Shift+Enter` | 多行输入 |
| `↑` / `↓` | 历史消息（输入为空时） |
| `Ctrl+R` | 历史搜索 |
| `Esc` | 弹层逐级关闭（overlay→模态→attach→设置）；busy 且无面板 = 中断 turn |
| `/` | 命令面板 |
| `@` | 引用补全（环境 / 文件 / 子代理 / 工具） |

### 读屏幕

- **块化流**：输入=块首，结论聚合亮顶，thought/工具卡折叠（关键信号：exit 码 / 崩溃 / flag / CVE / 端口），点开抽屉看完整输出。
- **后台任务**：状态栏显示长驻进程（`⛁ fuzz · 跑着`），退出时插行拍肩膀。
- **越界模态**：agent 要做跨界动作（写宿主等四类），逐次问人——**没有「永远允许」**。
- **决策面板**：模型方向分歧/无把握时提请人拍板，决策块落流可追溯。
- **历史面板**：工具栏「▤ 历史」看/搜/载回旧会话。

---

## 6. 引擎能力：七个工具

agent 在会话里使用的工具，研究员需要知道它们的行为边界：

| 工具 | 做什么 | 使用时机 |
|---|---|---|
| `env_exec` | 在环境内执行一条命令，等它返回（exit/stdout/stderr） | 短命令：查事实、编译、跑 exp |
| `env_bg` | 后台长驻进程：start / poll / log / kill / list | **预计超 30 秒的命令**：长扫描、fuzz、监听 |
| `delegate_task` | 派子任务给专用子代理（fuzz-runner / crash-triager / vuln-hunter 等），结论回注主循环 | 独立子目标，避免污染主上下文 |
| `research_log` | 研究留痕（成败/漏洞类型/一句话结论/证据路径） | 拿到 flag / 确认根因 / 放弃时落一条 |
| `intel_search` | 本地情报索引检索（CVE / exploit / nuclei 模板） | 复现/验证漏洞前查先例——线索不是结论 |
| `expert_search` | 专家知识库检索（思路/技术/SOP，人审定才进库） | 识别到知识缺口时（反复失败/没把握/无先例）——决策级依据 |
| `expert_draft` | 把会话里的解法起草成专家知识草稿 | 你说「存为专家知识」时；人审后才生效 |

**人机关系**：边界之内（环境内执行、分析、留痕）agent 全自动推进；跨越边界（写宿主/动凭据/改网络/销毁有成果环境）才停下来问。**人只做授权官，不做驾驶员。**

**长任务纪律**：长命令走 `env_bg`——`env_exec` 一次性等返回，堵住它会拖死本轮。agent 知道这条纪律，但你在布置任务时也可以直接说「这个用后台跑」。

---

## 7. 情报检索

本地情报索引（CVE / exploit / nuclei 检测模板），agent 用 `intel_search` 查，人用 CLI 管：

```bash
zhishi intel update                     # 更新索引（默认 minimal 档）
zhishi intel update --mode window       # 近 3 年（约 150-230MB）
zhishi intel update --mode full         # 全量（约 300MB，按 maxSizeMb 自裁）
zhishi intel update --nuclei-file <本地cves.json>   # 网络不通时手动导入 nuclei 索引
zhishi intel status                     # 索引状态与水位
```

- 更新有实时进度（`⏳ 已入库 N 条`），可中断续传；数据源失败自动多源切换，不阻塞会话。
- agent 在**复现/验证漏洞前**会主动查情报（受影响版本、CVSS、公开 exploit、nuclei 检测模板）——情报是线索不是结论。
- 索引带「最后更新于」提示，让 agent 知道数据新旧。

---

## 8. 研究留痕与记忆

每次研究的关键节点，agent 会通过 `research_log` 落一条**成败信号**（任务类型 / 成败 / 漏洞类型 / 一句话结论 / 证据路径）。人侧查询与补记：

```bash
zhishi research list                    # 研究记录
zhishi research log ...                 # 手动补记
```

这些记录定期**按研究域蒸馏**成经验（经验不跨域混压，置信度分级），逐轮反喂进系统提示——**研究做得越多，下一次越少走弯路**。死路（非零 exit）与突破口（flag/CVE）在上下文压缩中永不裁剪。

### 研究报告导出（1.2.0）

GUI 里 `/export` 把当前工作区的研究记录组装成报告目录（`output/reports/<时间戳>-<环境>/`）：

- `report.md`：按域模板（渗透/白盒/二进制/通用）——事件时间线、漏洞、证据、复现步骤由代码钉死（LLM 只写过程叙述）
- `evidence/`：PoC/样本等环境内工件的本体（agent 留痕时挂了 `trajectory_ref` 的，导出时按单回收；回收要一次越界批准）
- 导出前会列出敏感项计数（flag/密钥/内网 IP）让人过目；默认完整导出，`/export sanitize` 出脱敏版
- 报告里标注「引用的专家知识」——结论可追溯到决策依据

### 专家知识库（1.2.1+）

`expert.db` 是权威知识层（与情报原料库、LLM 经验库分立）：思路 / 技术知识 / SOP，**人审定才进库**。agent 在识别到知识缺口时查 `expert_search`（决策级依据）；留痕可挂 `expert_refs` 追溯。

人侧管理：

```bash
zhishi expert list / show <id> / search <关键词>   # 浏览检索
zhishi expert new <标题>            # 新建（打开编辑器写，frontmatter + 正文）
zhishi expert import <文件>         # 导入现成的 JSON/YAML（单条或数组批量，逐条校验）
zhishi expert edit <id>             # 修改（编辑器往返）
zhishi expert review                # 审定 agent 起草的草稿（批准/编辑/丢弃）
zhishi expert promote <事件id>      # 把一条研究经验晋升为专家知识（人审定）
```

import 文件格式（JSON 或 YAML 自动识别；必填 title/kind/domain/applicability/content/criteria，可选 tags/reviewer；provenance 一律按 user 入库）：

```yaml
- title: 堆喷占位 size 经验
  kind: technique          # idea / technique / sop
  domain: binary           # binary / pentest / whitebox / ai-security / redteam / malware / intel / ctf
  applicability: glibc 2.3x 堆题，有页面对齐约束时
  content: 做法正文……
  criteria: 什么时候这套做法成立/失效的判定
  tags: heap, spray
  reviewer: 你的名字        # 也可用 --reviewer 统一兜底
```

会话里直接说「把刚才这个解法存成专家知识」也行——agent 起草，你审定。

---

## 9. MCP 服务器

扩展 agent 的工具面。配置与开关走 CLI（GUI 的 MCP 页签设计待定、置灰占位）：

```bash
zhishi mcp add <npm-spec | GitHub URL | 本地路径>   # 添加（含 OAuth 流程）
zhishi mcp list                                      # 清单
zhishi mcp enable <id> / disable <id>                # 启用/停用
```

CLI：`zhishi mcp list` / `list-status` 看状态（连接/工具数/错误），`zhishi mcp enable <id>` / `disable <id>` 开关（写盘 + 桥热重载，当前会话即刻生效），`zhishi mcp reload` 手动刷新。（GUI 的 MCP 页签设计待定、置灰占位——1.3.6。）

MCP 工具在会话里以 `mcp__<server>__<tool>` 命名，与内置工具同受边界规则管辖。

---

## 10. 常见问题

**环境连不上 / 认证失败**
- VM：确认 guest 里 sshd 在跑、端口 22 可达；公钥不通时 `zhishi env adopt` 会提示现场输入 guest 密码（不落盘）。
- 网络层问题优先查本机到 guest 的连通性（`ping` / `ssh`）。

**模型报 403 / 配额不足**
- 换一家已配 key 的供应商：状态栏模型切换器里直接选，或 CLI `zhishi model set-default`。

**intel update 慢 / 失败**
- 首次回填 NVD 数据量大（window 档约 15 万条），受速率限制，1 小时级耗时正常——有断点续传，中断重跑接着来。
- 数据源网络不通时：宿主机 `curl` 下载 nuclei 的 cves.json，用 `--nuclei-file` 导入。

**GUI 输入看起来「卡住」**
- turn 进行中：输入会排队注入（不是丢）；`Esc` 中断，`/queue` 看排队。
- 长任务无响应：确认任务是否该走 `env_bg`（见第 6 节长任务纪律）。

**后台进程去哪了**
- turn 结束/会话重置时，后台长驻进程会被**回收杀掉**（当前策略）；要长跑跨会话的任务，用 `env_bg` 之外的托管方式（如环境内 nohup + 下次认领——见 `docs/spec/env-bg-design.md` 的后续方向）。

---

## 附：文档索引

- 产品定位与决策历史：`docs/spec/security_researcher_agent_design.md`、`docs/spec/security_researcher_product_plan.md`
- 技术方案：`docs/spec/security_researcher_agent_tech_plan.md`
- TUI 技术规范（已退役归档）：`docs/spec/tui_tech_spec.md`
- 环境内长驻进程通道：`docs/spec/env-bg-design.md`
- 版本任务池：`docs/roadmap.md`
- 开发红线：`CLAUDE.md`（开发者/贡献者读）
