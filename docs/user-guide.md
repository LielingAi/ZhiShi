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
6. [引擎能力：工具面](#6-引擎能力工具面)
7. [情报检索](#7-情报检索)
8. [研究留痕与记忆](#8-研究留痕与记忆)
9. [MCP 服务器](#9-mcp-服务器)
10. [团队协作：团队大脑与角色权限](#10-团队协作团队大脑与角色权限)
11. [常见问题](#11-常见问题)

---

> **2.1 形态变更**：GUI 主窗口已删除，交互面只剩 TUI（`zhishi` 裸命令）。本文
> §5「GUI 操作」及安装章节里的桌面安装器描述均已过时，待整体重写；命令与业务
> 口径（环境 / 模型 / 记忆 / 团队）仍然有效。

## 1. 安装与启动

### npm（2.1 起的方式）

```bash
npm i -g @lielingai/zhishi     # 需要 Node >= 22.5（SQLite 驱动依赖 node:sqlite）
zhishi                          # 进 TUI（首次会自动拉起本地 sidecar）
zhishi --help                   # 子命令（环境 / 任务 / 专家 / 团队……）
```

- 平台 TUI 二进制走 optionalDependencies（`@lielingai/zhishi-tui-<platform>-<arch>`），
  装不上的平台会在启动时明确提示，并给出 `ZHISHI_TUI_BIN` 覆盖方式。
- sidecar 与内置资源（skill / subagent / 域清单 / 专家种子 / 环境配方）都随主包分发，
  单机开箱可用；`npm i -g` 后不需要另装 Tauri 桌面应用。
- **TUI 里输入 `/` 开头 = 直接跑 CLI 子命令**（输出贴成一个块）：
  `/model list`、`/model set-key deepseek sk-xxx`、`/env add --kind ssh …`、`/help`。
  动作中心 `Ctrl+K` 里动作可以直接执行（attach / 环境 / 任务 / 报告…），命令模板同样可搜，选中只填入输入框。

### 发行包（Windows，1.x–2.0 历史形态）

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

## 2. 第一次使用：正门与环境

GUI 打开**正门**（全幅启动台）——有环境时启动直接回昨天现场，无环境时在正门选/建：

- **环境卡片**（运行中 / 已停止 / 本机已有三组横铺）：点击切入该环境自己的工作线（已停止拦截提示先启动）；行尾 ⋯ 菜单有启动/停止/重建/重置/补齐/详情/删除。
- **台账条**（2.0）：发现同名环境重复登记时给合并入口（type-name 确认）；「清理」按钮列出僵尸环境（已停止 + 零使用痕迹）勾选删除。
- **本机已有（未注册）**：自动发现宿主机的 Docker 镜像（zhishi-env-*）与 VM——镜像行一键「启动为环境」，VM 登记需补 guest 地址，凭据三选一：密钥路径 / guest 登录密码（一次性密钥引导，不落盘）/ **密码引用 `env:VAR`**（推不进公钥的防火墙、网络设备走这个）。1.5.10 起容器不可认领（接进来是半成品；zhishi 建的容器经 up 回写自动进登记）。
- **新建环境**：「＋ 新建环境」四步向导——docker 配方（一次性容器）/ VM 配方（持久可回滚）/ 接入已有 / 手动 SSH。

### 只密码设备（推不进公钥）

摄像头、交换机、老服务器这类设备无法写入公钥，密码是唯一凭据——登记时走**密码引用**（D-T4 红线不动：条目只存引用，密码本体永不落盘）：

- **登记**：新建向导「手动 SSH」的**密码引用 passwordRef** 填 `env:变量名`（如 `env:CAM01_PW`）；CLI 等价：`zhishi env add --kind ssh --id cam01 --host 192.168.1.50 --user admin --password-ref env:CAM01_PW`。与 keyPath 同给时**密钥优先**（passwordRef 被忽略）。
- **供值**（执行机 = 跑 zhishi 的那台；团队模式 = 大脑服务器）：一是执行机的环境变量；二是集中维护 `<数据目录>/secrets.env`（`KEY=VALUE` 每行一个，建议 `chmod 600`）——sidecar 启动自动加载，同名真实环境变量优先。多台设备 = 每行一个变量、条目各指各的。
- **能力边界**（v1）：命令执行（`env_exec` / 环境内一次性执行 / 探测补装）全可用；**文件传输（put/get/extract）与终端 attach 暂不支持**——会给出明确错误而不是挂起，需要时先给条目配 keyPath（可用 `zhishi env add --password` 现场推一次公钥自动配置）。
- **手动接入 SSH 主机**：host / 用户 + 凭据（密钥路径**或**一次登录密码）+ 端口/配方绑定。1.6.5 起缺密钥时可用**密码引导**：现场输入一次登录密码（不落盘），自动生成密钥对并推进公钥——「一次密码，永久密钥」。断网 Windows VM 同样支持（vmrun 客户机通道）。

**多环境**（2.0）：底栏环境 chip（`● 当前环境 ·N ▾`）点开**环境面板**——一行一环境：状态 / **在干什么**（auto loop 任务与状态、战役状态）/ **最近完成**；点行即切。**任务跑切环境不打断**（2.0.2：引擎按线各跑各的，原任务原地跑完，auto loop 收口有全局回执）。跨环境传文件：`/xfer 源环境:路径 目标环境:路径`（一条命令）。

**两条铁律**：

1. **创建权在人**——环境只能由人创建/纳管，agent 不会自建环境。
2. **能力跟着现场走**——环境的能力集合由现场推导（装了什么工具就是什么能力），域切换在集合内进行，不随环境类型绑死。

**术语**（2.0.2 统一）：**线** = 一个环境上的独立工作线程（对话历史 + 研究档案 + 任务形态）；环境是场地，线是活。历史页里的每条线是它的存档视图；档案看板里的「假设链」= 假设→证据→结论的链条。

---

## 3. 环境管理

### CLI 命令

```bash
zhishi env recipes                              # 内置环境类型清单
zhishi env up pwn-vm                            # 从环境类型建环境（首次构建需几分钟）
zhishi env adopt pwn-vm --vm <vmx路径> --user <用户>   # 纳管已有 VM
zhishi env list                                 # 已登记环境
zhishi env ps                                   # 运行中实例
zhishi env set vsrx-133                         # 回显单条字段（凭据/端口/OS 家族）
zhishi env set vsrx-133 --clear key-path --password-ref env:VSRX_PW
                                                # 改条目字段（2.0.6）：只认密码的设备必须
                                                #   摘掉 keyPath——密钥优先会让密码通道静默失效
```

> **凭据二选一**：`keyPath`（公钥）与 `passwordRef`（`env:VAR` 密码引用）在
> `kind=ssh` 条目上互斥；`kind=vm` 允许并存（联网走密钥、断网走 vmrun 密码），
> 但**联网时仍是密钥优先**——对着只认密码的防火墙/网络设备，要 `--clear key-path`。

### GUI 操作

| 操作 | 作用 |
|---|---|
| 环境行点击 | 切到该环境自己的线（每环境独立历史，来回切换不串场） |
| ⋯ 菜单 | 启动 / 停止（有损确认）/ 重推能力集合 / 详情（配方绑定管理）/ 删除 |
| `/snapshot [名]` | 给当前环境打快照（干净现场，反复回滚的底气） |
| `/rollback <快照名>` | 回滚到快照 |
| attach 页 | 真终端接管环境 shell（xterm + WS pty）+ 一次性命令执行双模式 |
| `/extract <环境内路径>` | 回收环境内文件到宿主 |
| `/xfer <源:路径> <目标:路径>` | 跨环境传文件（2.0：docker cp/vmrun/scp 一条命令） |

切换环境会**同时切到该环境自己的线**（每环境独立历史，来回切换各接各的，不串场）。**任务运行中也能切**（2.0.2：引擎按线并存，原任务原地跑完不被打断；唯一例外是目标线自己也在跑——等它跑完或先停）。

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

输入 `/` 或 **`Ctrl+K`（命令中枢）**——同一个引擎两个门：空输入显示动词目录 + 最近历史；输动词前缀过滤；输完动词 + 空格自动出**对象补全**（如 `/resume` 出线列表、`/use` 出环境、`/kill` 出战役）。

| 命令 | 作用 |
|---|---|
| `/snapshot [名]` / `/rollback <名>` | 环境快照 / 回滚 |
| `/extract <环境内路径>` | 回收环境内文件到宿主 |
| `/push <宿主路径> <环境内路径>` | 传入宿主文件到环境 |
| `/xfer <源环境:路径> <目标环境:路径>` | 跨环境传文件（2.0） |
| `/use <环境id>` | 中途切环境（对象补全；任务跑着也能切，原任务照跑） |
| `/gate` | 打开正门（环境管理） |
| `/resume <线id>` | 切线（对象补全） |
| `/kill <战役id>` | 终止战役（二次确认） |
| `/mission <形态>` | 改任务形态（挖掘/利用/复现/ctf/无类型） |
| `/rewind` | 回退到历史消息（改完重发） |
| `/fork` | 从某条消息分叉出新线 |
| `/queue` | 查看/取消排队消息 |
| `/tasks` | 任务中心（检查面板页签同源：战役对象卡/后台进程/子代理） |
| `Alt+x → 导出研究报告` | 导出报告目录（index.md + report.md + findings/ + evidence/ + report.zip），需一次越界批准 |
| `Alt+x → 重置当前会话` | 重置当前线：清上下文 + 新轨迹文件（旧轨迹封存于 `~/.zhishi/loop-sessions/` 可审计）。破坏性：强停当前回合、丢弃排队/纠偏、回收后台进程。与 CLI `zhishi env reset`（docker 换干净容器）是两件事 |
| `/help` | 命令帮助 |

研究四命令（1.5.0 触发权归人——查证/拍板/归档由你一键触发，结果通吃当前线上下文）：

| 命令 | 作用 |
|---|---|
| `/expert [查询词]` | 查专家库（专家审定知识），结果注入会话供模型继续；留空 = 取当前上下文为查询词 |
| `/intel [CVE/关键字]` | 查情报库（CVE/PoC 线索），同上注入；留空吃上下文 |
| `/archive` | 让模型回顾近期进展，把假设/证据/结论整理进研究档案（档案页签同步） |
| `/decide [议题]` | 让模型就议题产 2-4 个互斥选项卡，你拍板后它继续；留空取当前上下文焦点 |

### 快捷键

| 键 | 作用 |
|---|---|
| `Enter` | 发送；turn 进行中发送 = 纠偏注入（不打断，下一轮接住） |
| `Alt+Enter` | 换行 |
| `Ctrl+K` | 动作中心：搜索并直接执行（attach / 环境 / 任务 / 报告 / 搜索…）；命令模板同样可搜 |
| `/` | 斜杠命令：直接跑 CLI 子命令，输出贴成块 |
| `@` | 文件 / 环境补全 |
| `Alt+j` / `Alt+k` | 移动块光标 |
| `Alt+r` | 展开 / 折叠选中块 |
| `Alt+y` | 复制选中块 |
| `Ctrl+F` | 搜索：本会话 → Tab 扩到记忆 / 专家 / 情报 |
| `F1` | 键位帮助 |
| `F2` / `Alt+m` | 鼠标接管 / 交还终端（交还后可拖选复制） |
| `Ctrl+C` | 连按两次退出 |

### 读屏幕

- **单列布局**：顶部 header（地址 / 线 / 状态）· 会话流 · 输入板 · 状态行（模式 / 模型 / context / 队列 / 提示）。
- **块化流**：工具块折叠（exit 码 / 失败 / 行数），结论聚合亮顶；`Alt+r` 展开看完整输出。
- **面板**：`Alt+e` 环境、`Alt+t` 任务、`Alt+a` 档案、`Alt+l` 线、`Alt+w` 自动循环、`Alt+d` 待答请求、`Alt+x` 会话操作。
- **回执**：状态行右侧一条提示；错误/降级才进会话流成块。
- **越界模态**：agent 要做跨界动作（写宿主等四类），逐次问人——**没有「永远允许」**。
- **研究档案**：假设 / 证据 / 结论 / 未决问题随研究实时生长，`Alt+a` 看详情。
- **auto 观察卡**：`Alt+w` 看阶段 / 轮次 / 预算 / 最近结论。

---

## 6. 引擎能力：工具面

agent 在会话里使用的工具（17 个 + 语义查询），研究员需要知道它们的行为边界：

| 工具 | 做什么 | 使用时机 |
|---|---|---|
| `env_exec` | 在环境内执行一条命令，等它返回（exit/stdout/stderr） | 短命令：查事实、编译、跑 exp |
| `env_bg` | 后台长驻进程：start / poll / log / kill / list | **预计超 30 秒的命令**：长扫描、fuzz、监听 |
| `code_query`（1.9.10） | 环境内 CPG 语义查询（joern）：数据流/调用图/结构定位——「memcpy 且 len 来自报文字段」一语句命中 | 超大项目的代码审计（grep 撞不动时） |
| `delegate_task` | 派子任务给专用打法（fuzz-runner / crash-triager / vuln-hunter 等），结论回注主循环 | 独立子目标，避免污染主上下文 |
| `research_log` | 研究留痕（成败/漏洞类型/一句话结论/证据路径） | 拿到 flag / 确认根因 / 放弃时落一条 |
| `research_archive` | 研究档案：假设/证据/结论/未决问题四类实体 + 证伪/纠正（1.4.4） | 研究全程维护——假设驱动实验、结论挂证据、证伪同样留痕 |
| `intel_search` | 本地情报索引检索（CVE / exploit / nuclei 模板） | 复现/验证漏洞前查先例——线索不是结论 |
| `expert_search` | 专家知识库检索（思路/技术/SOP，人审定才进库） | 识别到知识缺口时（反复失败/没把握/无先例）——决策级依据 |
| `expert_draft` | 把会话里的解法起草成专家知识草稿 | 你说「存为专家知识」时；人审后才生效 |
| `request_decision` | 方向分歧（方案互斥、代价不可逆）时提请人拍板，弹决策面板 | 模型自己选不出来、且专家库无基准时 |
| `declare_completion` | auto 中宣称达成：列出声称达成的验收条件 + 证据引用，harness 做证据存在性预检 | 任一条件（OR）有证据支撑时；预检不过会回注继续跑 |

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

### 研究报告导出

TUI 里 `Alt+x` → 「导出研究报告」把当前工作区的研究记录组装成报告目录（`output/reports/<时间戳>-<环境>/`）：

- `index.md`：摘要 + 先看结论 + 漏洞清单（链接到单条结论）+ 目录
- `report.md`：按域模板（渗透/白盒/二进制/通用）——事件时间线、漏洞、证据、复现步骤由代码钉死（LLM 只写过程叙述），顶部「先看结论」、底部「术语表」
- `findings/C-001.md`：每条档案结论一份（严重度 / CVSS / 受影响资产 / 影响 / 修复建议 / 来源 / 支持证据 / 反证）。档案没记录的字段标「未评定」，不补默认值
- `evidence/`：PoC/样本等环境内工件的本体（agent 留痕时挂了 `trajectory_ref` 的，导出时按单回收；回收要一次越界批准）
- `report.zip`：整目录打包；导出回执里有下载地址（`/report/download/<id>`，24 小时有效，只认登记过的随机 id）
- 报告只进研究团队内部：不做脱敏，也不做敏感扫描（需要对外分享时自行处理）
- 报告里标注「引用的专家知识」——结论可追溯到决策依据
- 1.4.4 起报告从研究档案派生：研究结论带证据锚（V#N）、证伪与纠正独立成节——报告不是另写的文案，是举证档案的投影

### auto（目标式研究循环）

auto 与交互会话同构：**设定目标 + 验收条件 + 强制超时，未达成、未到超时，就一直继续——模型没有自我退出权**（它说「不可行」只是轨迹内容，不是停点）。

- **启动表单**：任务名 / 环境（**2.0 起任选**，启动即锁定该环境）/ 目标 / 预算三选一（轮次 / token / 时间）/ **验收条件**（1-N 条，**任一满足即达成**）/ 可选「空转推进话术」（留空 = 内置默认：区分死路与墙；填 `off` = 关闭）
- **运行期**：不可输入、不可切环境，只能观察（会话流 + 观察卡 + 研究档案）+ Esc 终止；循环自走——空转注入推进话术、歧义自主决策、工具失败继续
- **停点只有四个**：条件命中（declare + harness 证据预检通过 → `completed`）/ 强制超时（→ `stopped`）/ Esc（→ `stopped`）/ API 故障连击 5 次（→ `exited`）。没有暂停点、没有终审、没有续命、没有自动报告
- **结束后交付物**：轨迹文件（loop-sessions jsonl，可回放）+ 研究事件（`zhishi research list`）+ 研究档案 + run 记录（`zhishi auto-run list`）——无报告文件
- CLI 用法：`docs/auto-run-cli.md`；设计：`docs/design/auto-redesign.md`；同 envKey 互斥闸：同一研究环境同时只允许一个活跃 run

### 研究档案（1.4.4）

研究 = 过程 + 成果。档案是研究状态的显式载体：假设（可验证断言）/ 证据（实验观察）/ 结论（必须有证据支撑）/ 未决问题四类实体，每轮注回模型上下文——模型在显式状态上工作，不从历史脑补。人侧在看板里读态势、做纠正：

- **纠正是一等操作**：点任意实体行填理由提交——原文不删、状态翻转、引用它的下游自动标「待复核」（不连坐）。权威序：人 > 专家知识 > 模型自证伪（你纠正过的条目模型不得翻案）。
- **证伪同样留痕**：实验推翻假设时模型也会纠正——排除的路也是成果，防止反复重访死路。
- 档案随会话走（跨会话经验归蒸馏弧管），报告导出时自动并入（见上）。

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
  domain: binary           # binary / pentest / ai-security / redteam / malware / whitebox / intel / fuzz / ctf
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

## 10. 团队协作：团队大脑与角色权限

> 1.8.7 起。拓扑：一个团队大脑（服务器上唯一的 sidecar）+ 远端客户端（应用 / CLI）。线、档案、claims、知识、蒸馏、环境全部集中在服务器上；成员机器上只保留宿主 shell 与自己的文件。**单机用户不需要这一章**——不配 `--host`、不开 auth，一切与旧版一致。

### 起大脑（2.0.5 起：一条命令）

```bash
# ① 发 token（secret 只打印一次，立刻保存）
zhishi auth add --name wren --role reviewer     # 给把关的人
zhishi auth add --name alice --role operator    # 给干活的成员
zhishi auth add --name guest --role readonly    # 给只看的人
# ② 启用鉴权（未启用就绑非回环会被拒绝启动）
zhishi auth enable
# ③ 起大脑：内置 node 直起 server-dist，前台常驻（Ctrl+C 停止），
#    自动带清扫免疫标记——GUI 重启/退出不会误杀它。
zhishi brain serve --host 10.0.93.49 --port 7411 --agent-dir <工作区目录>
# 缺省 127.0.0.1:7411 + 当前目录；源码开发态照旧：
# npm run server -- --host 192.168.x.x --port 7411 --agent-dir <工作区>
```

防火墙放行 7411 入站（一次性，管理员 cmd）：

```cmd
netsh advfirewall firewall add rule name="ZhiShi Brain 7411" dir=in action=allow protocol=TCP localport=7411
```

注意：`auth enable` 之后，**大脑所在机器上原有的 GUI/CLI 也要带 token**（GUI 设置 → 连接里填，CLI 用 `--token` / `ZHISHI_TOKEN`）。**2.0.8 起定时任务的 owner 是 sidecar**（`ZHISHI_TASK_SCHEDULER` 缺省 node，`rust`/`off` 是显式降级），所以**sidecar 所在机器**需要 `ZHISHI_TOKEN`；桌面宿主的内部请求（session-state 轮询、trust/event 上报）同样过统一鉴权闸：给宿主进程配置 `ZHISHI_TOKEN` 环境变量（建议 operator 档 token），应用启动时继承即可；未配置则定时任务会被 401 拒绝（日志可见），不静默绕过。

### 角色与权限（严格递增：readonly < operator < reviewer）

**只读（readonly）——只能看，不能改**

| 面 | 内容 |
|---|---|
| 线 | 看线状态、消息、队列；订阅 SSE 直播 |
| 清单与状态 | 环境/配方/引擎/实例的全部 list、show、status、search、ps、discover |
| 知识层 | 读专家库、情报库、记忆、研究留痕与蒸馏产物 |
| 配置 | `config/get`（`providerApiKeys`/`auth` 子树一律脱敏） |
| 其他 | `/refs/:id` 取文件字节、workspace 文件列表、auto-run/campaign 清单、任务只读视图 |

**操作员（operator）——只读 + 干活**

| 面 | 内容 |
|---|---|
| 会话 | 发消息、停止、重置、纠偏、rewind、fork、切线、排队管理；**在自己私有线上答 boundary/决策询问** |
| 环境 | 全生命周期：up/down/新建/执行/传文件（push/extract/put-file/get-file）/重建/快照回滚/登记 ssh/adopt VM/选定现场/打开终端 |
| 研究 | 留痕、推进实体（archive/resolve）、认领（claim）、触发蒸馏、情报同步、任务写操作 |
| 团队 | `line/list`、`line share/unshare`（把自己的私有线转团队线）、auto-run/campaign 操作、agent 启停配置、`config/set`（**不能**碰 `providerApiKeys`/`auth`） |

**审定人（reviewer）——操作员 + 权威动作**

| 面 | 内容 |
|---|---|
| 审批 | **答任何线上的 boundary/决策询问**（越界批准、系统级变更批准） |
| 档案裁决 | `archive/correct`（纠正，终身生效）/ `abandon`（搁置）/ 档案通用写 |
| 专家知识 | 审定入库（expert add/update/rm/review）——人审定才进库由这档执行 |
| 模型 | 加/删供应商、设 key、设默认模型 |
| 信任 | trust 账本的 resolve/reset/import |
| **鉴权本身** | `auth add/revoke/enable/disable`——发 token、撤 token、开关整个鉴权 |

叠在上面的两条线级规则：**私有线** = owner 读写，非 owner 的 operator 连读都不行；**共享线** = operator+ 可写、全员可读，但审批询问仍只有 reviewer 能答（owner 豁免只在自己的私有线上）。未登记进分类表的路由一律按 reviewer 档处理（宁可误拦不漏放）。完整的路由→角色表在 `src/server/auth/roles.ts`。

### 成员怎么连

- **GUI**：设置 → 连接 → 团队大脑 → 地址 + token。状态栏的**模式角标**常驻显示「本机 / 团队大脑 · host / 连接失败」，点它直达连接设置。
- **CLI**：`zhishi --server http://host:port --token <secret> <命令>`（或 `ZHISHI_SERVER` / `ZHISHI_TOKEN` 环境变量）。

### 传输：GUI 直连与 SSH 隧道（2.0.3 起）

**成员 GUI 为什么不能直接填 `http://<服务器IP>`**：webview 页面是安全上下文（`http://tauri.localhost`），Chrome 混合内容拦截会把页面向非回环 http 发起的**一切**请求挡在发出前（回环豁免，所以 `127.0.0.1` 没事）。（2.0.6 起 CORS 预检回显任意来源——鉴权门是 token；此前按 origin 白名单阻断的尝试曾把自家 webview 锁死，见 `src/server/auth/cors.ts` 模块头。）

**2.0.3 起成员零配置**：应用自带回环中继（等价内建 `ssh -L` 的哑 TCP 管道）——填地址 + token 即连，GUI 流量经 `127.0.0.1:<中继端口>` 转发到大脑，fetch / SSE / 终端 WebSocket / 大文件全透明。中继只绑回环、token 鉴权仍在大脑侧兜底。Windows 防火墙若弹窗提示 node.exe 联网，允许即可（那是中继在连大脑）。

CLI 不受浏览器层限制，`zhishi --server http://<IP>:7411 --token <secret>` 直接通。

**SSH 隧道降级为备选**：旧版成员应用（2.0.3 之前）、或浏览器 dev 页（无 Tauri 接不到中继）可用：

```bash
ssh -L 7411:127.0.0.1:7411 wren@192.168.x.x    # 成员各起一条隧道
# 然后 GUI / CLI 连 http://127.0.0.1:7411 + token
```

HTTPS 仍列为后续选项（服务端本体不碰 TLS，设计上架一层 terminator 才走 https——见 `docs/design/2.0.3-remote-relay.md`）。

### 线：私有线与共享线

- **私有线**（默认）：自己开自己用，`zhishi line list` 查看。
- **共享线**：`zhishi line share <id>` 把一条已存在的私有线转成团队线（成员可读、operator+ 可写、SSE 直播全员可见）；`zhishi line unshare <id>` 收回。
- 两条线可同时跑 turn 互不阻塞（多引擎）；空闲 30 分钟的引擎自动回收（transcript 在盘上，不丢历史），下次访问惰性重建。
- 文件传输：`zhishi env put-file <envId> <本地路径> <环境内路径>` / `get-file <envId> <环境内路径> <本地路径>`——成员笔记本 ↔ 服务器环境端到端（sha256 校验）。

---

## 11. 常见问题

**环境连不上 / 认证失败**
- VM：确认 guest 里 sshd 在跑、端口 22 可达；公钥不通时 `zhishi env adopt` 会提示现场输入 guest 密码（不落盘）。
- 网络层问题优先查**执行机**到 guest 的连通性（团队模式执行机 = 大脑服务器，不是你面前的成员机——成员机上 ssh 那个 VMnet 地址必然不通，那不能当证据）。
- `Permission denied (publickey,password,keyboard-interactive)` 是「客户端没交出凭据」，不是密码错：先 `zhishi env set <id>` 看 `keyPath`——它存在时 `passwordRef` 不生效。只认密码的设备（防火墙 / 交换机 / Junos、FreeBSD 类）：`zhishi env set <id> --clear key-path --password-ref env:XXX`，密码放执行机的 `<数据目录>/secrets.env`（`KEY=VALUE`，**启动时加载，改完要重启 sidecar**）。
- 非 Linux guest（Junos / FreeBSD / OpenWrt）：远端命令包装按能力自适应（有 `timeout` 就包、没有就裸跑，不依赖 bash/base64），但 Junos 的命令形态是 `cli -c 'show version'`，不是 Unix 命令。

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

- auto 设计（1.7.7 重做，策略治理见 `docs/auto-run-policy.md`）：`docs/design/auto-redesign.md`
- auto 命令行用法：`docs/auto-run-cli.md`
- 产品定位与决策历史：`docs/spec/security_researcher_agent_design.md`、`docs/spec/security_researcher_product_plan.md`
- 技术方案：`docs/spec/security_researcher_agent_tech_plan.md`
- TUI 技术规范（已退役归档）：`docs/spec/tui_tech_spec.md`
- 环境内长驻进程通道：`docs/spec/env-bg-design.md`
- 版本任务池：`docs/roadmap.md`
- 开发红线：`CLAUDE.md`（开发者/贡献者读）
