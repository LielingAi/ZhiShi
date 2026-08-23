# zhishi 使用指南

> 面向研究员的使用手册。从这里开始：安装 → 选环境 → 配模型 → 开始研究。
> 版本：v1.1.5。命令以本文为准；设计细节看 `docs/` 下的技术文档。

---

## 目录

1. [安装与启动](#1-安装与启动)
2. [第一次使用：正门与环境](#2-第一次使用正门与环境)
3. [环境管理](#3-环境管理)
4. [模型配置](#4-模型配置)
5. [TUI 操作大全](#5-tui-操作大全)
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
- **安装后点击桌面图标即直接打开 TUI**（弹一个终端跑 `zhishi agent`）；开机自启不会弹窗。托盘的「打开会话」菜单/左键同样拉起 TUI。
- 也可以自己开终端：`zhishi agent`。`zhishi` 命令在应用启动时自动同步到 `~/.zhishi/bin/`。Tauri 壳在后台负责引擎（sidecar）生命周期，无需手动起服务。

### 源码运行（开发态）

要求 Node.js ≥ 22：

```bash
npm install

# 终端 1：sidecar（引擎 + admin API）
node --import tsx/esm src/server/index.ts --agent-dir "$PWD"

# 终端 2：TUI（先 set ZHISHI_PORT=3000 指向 sidecar 端口）
node --import tsx/esm src/cli/zhishi.ts agent
```

### 退出

- TUI 空闲时 `Ctrl+C` 退出；`/quit` 退出会话界面。
- 发行包退出 TUI 后，后台壳仍在（托盘可退出）；源码运行时退出 sidecar 进程即可。

---

## 2. 第一次使用：正门与环境

TUI 启动即进**正门**——强制选择本次会话的工作环境（没有「宿主机模式」，研究只发生在环境里）：

- **已登记环境**：直接选中，未运行会尽力拉起（VM 会按快照约定恢复）。
- **本机已有（未注册）**：自动发现宿主机上的 Docker 容器与 VM，选中即登记。
- **新建环境（选类型）**：从内置环境类型新建——`dev`（开发）、`pwn` / `pwn-vm`（二进制利用）、`fuzz` / `fuzz-vm`（模糊测试）、`rev`（逆向）、`code-audit`（白盒审计）、`pentest`（渗透）、`ai-security`（AI 安全）。docker 类型需要本机 Docker；VM 类型需要 VMware/Hyper-V 等。
- **手动接入 SSH 主机**：已有机器走三步表单（host / 用户 / 密钥路径）。

**两条铁律**：

1. **创建权在人**——环境只能由人创建/纳管，agent 不会自建环境。
2. **环境类型绑定能力**——选了哪个类型的环境，agent 就用那套工具（类型自带工具链与技能）。

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

### TUI 命令

| 命令 | 作用 |
|---|---|
| `/env` | 重新选择工作环境（同时切到该环境自己的会话线） |
| `/snapshot [名]` | 给当前环境打快照（干净现场，反复回滚的底气） |
| `/rollback <快照名>` | 回滚到快照 |
| `/attach` | 接管环境 shell（TUI 挂起，exit 返回） |
| `/extract <环境内路径>` | 回收环境内文件到宿主 |

`/env` 切换环境会**同时切到该环境自己的会话线**（1.1.6：每环境独立历史，来回切换各接各的，不串场；turn 运行中会被拒绝，先 Esc 中断再切）。

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

### TUI 配置（不用退出去）

```
/model                              状态卡：各家 key 状态/当前默认/模型数
/model set-key <供应商id>           隐藏输入填 key（不回显，Enter 确认 Esc 取消）→ 自动拉列表
/model use <供应商id> <模型名>      切换模型（下一轮对话生效）
/model <模型名>                     快速切换（旧语法，模型名全局唯一时可用）
```

**提示**：主力供应商配额耗尽（如 403）时，另一家已配 key 的供应商可随时 `/model use` 切过去——模型可换，harness 不变。

---

## 5. TUI 操作大全

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/env` | 重新选择工作环境（同时切到该环境自己的会话线） |
| `/attach` | 接管环境 shell（TUI 挂起） |
| `/snapshot [名]` / `/rollback <名>` | 环境快照 / 回滚 |
| `/extract <环境内路径>` | 回收环境内文件到宿主 |
| `/model ...` | 模型配置/切换（见上节） |
| `/mcp [enable\|disable <id>] [-r]` | MCP 状态/开关/刷新 |
| `/rewind` | 回退到历史消息（改完重发） |
| `/fork` | 从某条消息分叉出新线程 |
| `/queue` | 查看/取消排队消息 |
| `/tasks` | 查看子任务与后台进程（列表 → Enter 看结论详情） |
| `/export` | 导出研究报告（report.md + evidence/；`/export sanitize` 出脱敏版，需一次越界批准） |
| `/reset` | 重置对话（新会话） |
| `/help` | 键位与命令帮助 |
| `/quit` | 退出会话界面 |

### 键位

| 键 | 作用 |
|---|---|
| `Enter` | 发送；turn 进行中发送 = 纠偏注入（不打断，注入下一轮） |
| `Ctrl+J` / `Alt+Enter` | 多行输入 |
| `↑` / `↓` | 历史消息（输入为空时） |
| `Ctrl+R` | 历史搜索 |
| `Esc` | 中断 turn / 关闭面板 / 回到底部；清空草稿可用 `↑` 或 `Ctrl+Y` 找回一次 |
| `Ctrl+Z` | 回退到历史消息（rewind） |
| `Ctrl+O` | 展开/收起最近工具输出 |
| `Ctrl+L` | 开关帮助 |
| `PgUp` / `PgDn` | 回看会话（整页翻）；`Ctrl+Home` 跳到顶部；滚轮逐行翻看 |
| `Tab` | 补全 / `@` 引用 |
| `Ctrl+C` | 清空输入；空输入时中断；空闲时退出 |
| `/` | 命令面板 |
| `@` | 引用环境 / 文件 |

### 读屏幕

- **工具卡**：agent 每步动作一张卡，折叠后只留关键信号（exit 码 / 崩溃 / flag / CVE / 端口）。`Ctrl+O` 展开最近输出。
- **后台任务**：状态行显示长驻进程（`⛁ fuzz · 跑着`），退出时插行拍肩膀。
- **越界模态**：红色框 = agent 要做跨界动作（写宿主等四类），逐次问人——**没有「永远允许」**。
- **中断五档**：`Esc` 停止 · 运行中输入即纠偏 · `Ctrl+Z` 回思路 · `/rollback` 回环境 · `/attach` 接管 shell。

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

TUI 里 `/export` 把当前工作区的研究记录组装成报告目录（`output/reports/<时间戳>-<环境>/`）：

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

扩展 agent 的工具面。配置走 CLI，开关走 TUI：

```bash
zhishi mcp add <npm-spec | GitHub URL | 本地路径>   # 添加（含 OAuth 流程）
zhishi mcp list                                      # 清单
zhishi mcp enable <id> / disable <id>                # 启用/停用
```

TUI 内：`/mcp` 看状态（连接/工具数/错误），`/mcp enable <id>` / `disable <id>` 开关（写盘 + 桥热重载，当前会话即刻生效），`/mcp -r` 手动刷新。

MCP 工具在会话里以 `mcp__<server>__<tool>` 命名，与内置工具同受边界规则管辖。

---

## 10. 常见问题

**环境连不上 / 认证失败**
- VM：确认 guest 里 sshd 在跑、端口 22 可达；公钥不通时 `zhishi env adopt` 会提示现场输入 guest 密码（不落盘）。
- 网络层问题优先查本机到 guest 的连通性（`ping` / `ssh`）。

**模型报 403 / 配额不足**
- 换一家已配 key 的供应商：TUI 里 `/model use <供应商> <模型>`，或 CLI `zhishi model set-default`。

**intel update 慢 / 失败**
- 首次回填 NVD 数据量大（window 档约 15 万条），受速率限制，1 小时级耗时正常——有断点续传，中断重跑接着来。
- 数据源网络不通时：宿主机 `curl` 下载 nuclei 的 cves.json，用 `--nuclei-file` 导入。

**TUI 输入看起来「卡住」**
- turn 进行中：输入会排队注入（不是丢）；`Esc` 中断，`/queue` 看排队。
- 长任务无响应：确认任务是否该走 `env_bg`（见第 6 节长任务纪律）。

**后台进程去哪了**
- turn 结束/会话重置时，后台长驻进程会被**回收杀掉**（当前策略）；要长跑跨会话的任务，用 `env_bg` 之外的托管方式（如环境内 nohup + 下次认领——见 `docs/env-bg-design.md` 的后续方向）。

---

## 附：文档索引

- 产品定位与决策历史：`docs/security_researcher_agent_design.md`、`docs/security_researcher_product_plan.md`
- 技术方案：`docs/security_researcher_agent_tech_plan.md`
- TUI 技术规范：`docs/tui_tech_spec.md`
- 环境内长驻进程通道：`docs/env-bg-design.md`
- 版本任务池：`docs/roadmap.md`
- 开发红线：`CLAUDE.md`（开发者/贡献者读）
