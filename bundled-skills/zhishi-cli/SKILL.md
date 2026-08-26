---

name: zhishi-cli

description: >-

  你正在 ZhiShi 这款 AI 产品里运行——ZhiShi 自带一套"产品能力"（定时任务、任务中心、MCP 工具接入、

  模型 Provider、Skills 安装、Generative UI Widget 等），全部通过内置 `zhishi` CLI 暴露给你。

  当用户的需求**落在 ZhiShi 产品能力的射程内**，就加载并使用这个 skill，用 CLI 主动帮用户把事情做掉，

  而不是让用户去 GUI 点击。

  典型触发场景：用户说"每天 X 点帮我 Y"（→ task 定时）、"派发成任务"（→ task）、

  "接个 X 工具进来"（→ mcp）、"配 X 模型/Provider"（→ model）、

  "装个 X skill"（→ skill）、"做个图表/仪表盘"

  （→ widget readme）、"看下我有啥任务/定时/版本"（→ list / status / version）、"改下应用设置"（→ config）。

  即使用户没说"用 ZhiShi 做"几个字，只要意图能映射到上述能力之一，就该走这个 skill。

  反向边界：纯业务任务（写代码、查资料、读文件）不归这里。

author: ZhiShi

---



# zhishi-cli — ZhiShi 产品能力的 CLI 入口



你正运行在 ZhiShi 产品内。ZhiShi 不只是一个 chat UI，它是一套带状态的 Agent 平台：定时任务、任务中心、MCP、Provider、插件、Skill、Widget——这些都是产品能力，由内置 `zhishi` CLI 一站暴露给你。



**这个 skill 不只是"管理工具"，它是 ZhiShi 产品能力的执行入口**。用户表达的需求只要能映射到产品能力，就该用 CLI 主动帮用户做掉，而不是给用户一堆操作步骤让他自己去 Settings 点。这份文档列出全部能力以及"什么时候应该用哪条命令"。



## 前置：CLI 是否可用



CLI 通过 `~/.zhishi/bin/zhishi` 暴露，你的 SDK 子进程 PATH 已注入这个目录，直接 `zhishi <command>` 就能跑。它通过 HTTP 走 Sidecar Admin API（端口由环境变量 `ZHISHI_PORT` 注入）。



- 遇到 `command not found`：让用户重启一次应用触发 CLI 同步

- 遇到 `ECONNREFUSED`：Sidecar 没起来，让用户检查应用是否在运行



## 使用模式



1. **探索先行**：不熟的命令组用 `zhishi <group> --help`，**不要靠猜**

2. **预览写操作**：所有写命令支持 `--dry-run`，先给用户看会改什么再执行

3. **机器可读**：加 `--json` 解析结构化输出

4. **失败即恢复**：CLI 失败响应会带 `→ Run: <cmd>` 恢复提示，照着跑就行



## 安全规范



- **改配置前必先 `--dry-run`**——配置数据是用户的命脉，预览给用户看是保护他们的安全网

- **API Key**：用户在对话里明确给了你才写入；没给就引导他去 **设置 → 对应页面** 填，不要追问

- **删除前确认**：用户说"删了吧"也要回读"我要删的是 X，确认吗"



## 生效时机



- **MCP 工具变更**（增删改 / 启禁用 / 环境变量 / OAuth）：磁盘立即写入，但工具在**下一轮对话**才能调用——MCP server 在 session 创建时绑定。当前轮配完后告诉用户："发条新消息我就能用了"

- **其他配置**（Provider / Agent / task / skill / config）：写入即时生效



---



## 命令速查 + 何时使用



### MCP 工具（mcp）



```bash

zhishi mcp list                                       # 看用户配了哪些 MCP

zhishi mcp show <id>                                  # 看某个 MCP 的完整配置（command/args/env/headers）

zhishi mcp add --id <id> --type <stdio|sse|http> ...  # 新增

zhishi mcp remove <id>                                # 删除

zhishi mcp enable <id> --scope <user|project|both>    # 启用

zhishi mcp disable <id> --scope <user|project|both>   # 禁用

zhishi mcp test <id>                                  # 实际握手测试连通性

zhishi mcp env <id> set KEY=val [KEY2=val2 ...]       # 设环境变量（覆盖）

zhishi mcp env <id> get [KEY ...]                     # 读环境变量

zhishi mcp env <id> delete KEY [KEY2 ...]             # 删环境变量

zhishi mcp oauth discover <id>                        # 探测 MCP server 是否支持 OAuth + 拿到 metadata

zhishi mcp oauth start <id> [--clientId X --clientSecret Y --scopes "..." --callbackPort N]

                                                        # 启动 OAuth 授权流程（会打开浏览器）

zhishi mcp oauth status <id>                          # 看授权状态（已授权 / token 是否过期）

zhishi mcp oauth revoke <id>                          # 撤销授权

```



**何时用：**

- "帮我接个 X 工具" → `mcp add` → `mcp enable --scope both` → `mcp test`

- "看下 playwright 配的啥" → `mcp show playwright`

- "Notion MCP 怎么登录" → `mcp oauth discover` 看支持的 scopes，再 `mcp oauth start`

- "X 工具用不了，是不是登录过期了" → `mcp oauth status <id>`，过期就重跑 `oauth start`

- "给 fetch 加个 API Key 环境变量" → `mcp env fetch set FETCH_API_KEY=sk-xxx`



### 模型 Provider（model）



```bash

zhishi model list                                     # 看所有 Provider + 验证状态

zhishi model add --id <id> --name <显示名> --base-url <url> --models <m1,m2,...> [其它]

zhishi model remove <id>                              # 删除自定义 Provider（内置的删不掉）

zhishi model set-key <id> <apiKey>                    # 设 API Key

zhishi model set-default <id>                         # 设为默认 Provider

zhishi model verify <id> [--model <某个具体模型>]      # 实际发一条测试消息验证

```



**何时用：**

- "帮我配 DeepSeek" → 内置 Provider 直接 `model set-key deepseek <key>` → `model verify`

- "我要用一个新厂商" → 详见下方 §配置模型服务流程

- "把默认改成智谱" → `model set-default zhipu`

- "我之前加的那个废 Provider 删了吧" → `model remove <id>`



### Agent + Channel（agent）



```bash

zhishi agent list                                     # 列出所有 Agent

zhishi agent show <id>                                # 看某 Agent 的 effective 默认（runtime/model/permissionMode）

zhishi agent enable <id>                              # 启用

zhishi agent disable <id>                             # 禁用

zhishi agent set <id> <key> <jsonValue>               # 改单个字段（key/value 形式，value 必须是合法 JSON）

                                                        # 受保护字段：id / channels

```



**何时用：**

- "我那个 Agent 现在啥配置" → `agent show <id>`，读 effective 默认值

- "把 Agent X 的 model 改成 Y" → `agent set X model '"Y"'`（注意 JSON 字符串要双层引号）

- "把 permissionMode 改成 plan" → `agent set X permissionMode '"plan"'`



`agent set` 和 `agent show` 互补：show 读 effective 值，set 写**单个**字段。



### 研究环境（env）



```bash

zhishi env engines [--fresh]                          # 探测 docker/Hyper-V/VBox/VMware/libvirt/ssh 引擎 + 安装引导

zhishi env recipes                                    # 环境配方（bundled：dev/pwn/fuzz docker + pwn-vm）

zhishi env up <recipe> [--vm-base X.vmx] [--user U] [--key-path K]   # 从配方起环境（docker build+run / VM 直连启动，D22 不拷贝）

zhishi env ps                                         # 运行中实例合集（docker + vmware + hyperv + vbox，带 DRIVER 列）

zhishi env down <id>                                  # 停环境（docker=stop+rm；VM=stop soft 停真实 VM，文件不动）

zhishi env rm <id>                                    # 摘除环境登记（运行中拒绝；VM 文件绝不删）

zhishi env adopt <recipe> --vm <X.vmx> [--user U]     # 认领已有系统的 VM 为模板（自动初始化+快照，密码现场输入不落盘）

zhishi env build <recipe> [--iso PATH] [--disk-gb N]  # 从零自动构建模板（ISO autoinstall 无人值守）

zhishi env exec <env-id> [--guest-user U] -- <cmd>    # 断网隔离 VM 的一次性命令（vmrun guest-exec，密码现场输入）

zhishi env list                                       # 具名环境（ssh/docker/vm 条目）

zhishi env add --kind ssh --id dev --host H [--port N] [--user U] [--key-path K]

zhishi env open <id>                                  # 嵌终端接入环境（ssh / docker exec / vm ssh）

zhishi env remove <id>

```



**何时用：**

- "给我个干净 pwn 环境" → `env up pwn`；VM 版 `env up pwn-vm`（首次先 `env adopt` 或 `env build` 养成模板）

- "样本要在断网 VM 里跑" → 隔离 VM 起好后 `env exec <id> -- ./malware`（guest-exec，不需要网络）

- "进环境干活" → `env open <id>`；交互会话用 GUI 主窗口（1.3.9 起 `zhishi agent` 无参数已退役，仅子命令 list/show/enable/disable/set 可用）





### Skills（skill）



```bash

zhishi skill list                                     # 已装 skill（用户级 ~/.zhishi/skills）

zhishi skill info <name>                              # 某 skill 的详情

zhishi skill remove <name>                            # 删除

zhishi skill enable <name>                            # 启用

zhishi skill disable <name>                           # 禁用

```



技能市场 / URL 安装管线已删除（wave 3b）——新 skill 通过插件体系或直接把目录放进 `~/.zhishi/skills/` 获得。



### 定时任务（= 任务 + schedule）



ZhiShi 没有独立的"cron"概念——**定时是任务（task）的一个属性**。创建 scheduled 任务用 `zhishi task create-direct` 加调度参数：



```bash

zhishi task create-direct --name "日报" --workspaceId <id> --workspacePath <abs> \

    --taskMdFile /tmp/task.md \

    --executionMode recurring --intervalMinutes 30        # 每 30 分钟



zhishi task create-direct --name "日报" --workspaceId <id> --workspacePath <abs> \

    --taskMdContent "做什么、怎么做、验收标准" \

    --executionMode recurring --cronExpression "0 18 * * *" --cronTimezone "Asia/Shanghai"

                                                            # 标准 cron 表达式（每天 18:00）



zhishi task create-direct --name "一次性提醒" --workspacePath <abs> \

    --taskMdContent "..." --executionMode scheduled --dispatchAt 2026-08-01T09:00:00+08:00

                                                            # 到点跑一次



zhishi task update <taskId> --intervalMinutes 60          # 调节奏

zhishi task update-status <taskId> stopped                # 暂停（保留配置）

zhishi task run <taskId>                                  # 立刻派发一次

zhishi task delete <taskId>                               # 删除

```



**何时用：**

- "帮我每天 6 点出日报" → `create-direct --executionMode recurring --cronExpression "0 18 * * *"`

- "每半小时看一眼 X" → `--executionMode recurring --intervalMinutes 30`

- "停了它别再跑" → `task update-status stopped`；彻底删用 `task delete`

- "上次执行成功了吗" → `zhishi task get <taskId>`（statusHistory + 关联会话）

- AI 在定时任务运行中判断"该结束了" → 在最终输出里带 `[CRON_TASK_COMPLETE: 原因]` 标记（需任务开启 Allow AI to exit）







### 任务中心（task）



```bash

zhishi task list [--status X --workspaceId X --tag X --includeDeleted]

zhishi task get <taskId>                              # 详情 + statusHistory + 各 .md 文档路径

zhishi task create-direct --name "..." --workspaceId <id> --workspacePath <abs> \

    [--taskMdFile <path> | --taskMdContent "..."] \

    [--model X] \

    [--executor agent --executionMode once|scheduled|recurring|loop --runMode X --tags x,y --sourceThoughtId X] \

    [--intervalMinutes N | --cronExpression X --cronTimezone Z | --dispatchAt T]

zhishi task create-from-alignment <alignmentSessionId> --name "..." [--run] [其它同 create-direct]

                                                        # 从 AI 对齐会话物化任务（workspaceId/Path/sourceThoughtId 自动继承）

                                                        # --run 创建后立刻派发，省一步

zhishi task run <taskId>                              # 派发 todo 任务

zhishi task rerun <taskId>                            # 从 blocked/stopped/done 重新派发

zhishi task update-status <taskId> <status> [--message "..."]

                                                        # 状态机：todo→running→verifying→done（或 →blocked/stopped）、done→archived

zhishi task append-session <taskId> <sessionId>       # 把一个聊天 session 关联到任务（任务过程中开了新会话用这个登记）

zhishi task archive <taskId> [--message "..."]        # 归档（仅用户可操作；AI 走会被拒）

zhishi task delete <taskId>                           # 软删除（30 天保留）

```



### 长期记忆（memory）



```bash

zhishi memory search '<关键词>' [--kind reminder --limit N] [--json]

                                                        # 检索长期记忆库（蒸馏弧从真实工作史压出的

                                                        # 认知 + 主动沉淀）。按有效分排序，每条带

                                                        # 内容 / 来源 / id / salience / usefulness。

```



**何时用：** 当前任务依赖过去上下文时——用户的偏好、验收标准、过去的决定、踩过的坑。引用时明说来自记忆：命中会被记录（recall 日志），遭用户纠正的记忆会被蒸馏弧的 judge 自动重罚降权，诚实归因让这个回路保持健康。不要每轮都搜，只在真正需要时。



**任务级 model 覆盖**：`create-direct` / `create-from-alignment` 支持仅对该任务生效的 `--model` 覆盖，**不会改 Agent 工作区默认**。



| Flag | 语义 |

|------|------|

| `--model` | builtin 模型 id，不传则继承工作区默认 |



**何时用：**

- "看我还有啥没做完的" → `task list --status running` / `task list`

- "这个想法派发出去" → `task create-from-alignment <sessionId> --name "..." --run`

- "创个 review PR 的任务换个模型跑" → `task create-direct ... --model claude-sonnet-4-6`

- "任务过程中我开了个新对话登记一下" → `task append-session <taskId> <sessionId>`

- "标记完成" → `task update-status <taskId> done --message "..."`

- "重新跑一遍" → `task rerun <taskId>`

- 只读类 `task get` / `task list`：CLI 输出会带各 `.md` 文档路径（task.md / verify.md / progress.md / alignment.md），用 Read/Edit/Write 直接读改即可



**验证与恢复**：输出会打印 `overridesRequested` vs `overridden`，传了 override 但没落到持久化态会明确提示 drift。



### 通用配置 + 状态（config / status / version / reload）



```bash

zhishi config get <key>                               # 读，支持点号路径如 proxySettings.host

zhishi config set <key> <value> [--dry-run]           # 写，value 是 JSON 字面量（字符串要带引号）

zhishi status                                         # 应用整体运行状态

zhishi version                                        # 应用版本号

zhishi reload [--workspacePath <abs>]                 # 热加载配置（不重启进程）

```



**何时用：**

- "现在配的代理是啥" → `config get proxySettings`

- "把代理 host 改成 X" → `config set proxySettings.host '"X"'`

- "应用版本" → `version`

- "改完手动让它生效" → `reload`（多数命令已经自动 broadcast，这个是兜底）



### Generative UI Widget 设计文档（widget）



```bash

zhishi widget readme                                  # 看有哪些 widget 模块（chart/diagram/interactive/dashboard/art）

zhishi widget readme <module1> [<module2> ...]        # 拉具体模块的完整设计规范

```



**何时用：**

- 用户让你"做个图表 / 仪表盘 / SVG 流程图"前，先 `widget readme <module>` 拉对应模块的完整规范（含输出格式契约、palette、组件库），**不要凭印象写**

- 模块清单：`chart`（Chart.js 图表）/ `diagram`（SVG 流程图）/ `interactive`（滑块/计算器/对比卡）/ `dashboard`（多图表 + 控件）/ `art`（SVG 插画）

- 渲染输出有严格 `<generative-ui-widget>` 格式契约——readme 开头会说明，跳读会出错



`widget readme` 是 progressive disclosure：brief 已经在系统 prompt 里，要用时才 fetch full doc。



---



## 典型工作流



### 接入 MCP 工具



1. 从用户给的文档提取：server ID、类型（stdio/sse/http）、command 或 URL、所需环境变量

2. `zhishi mcp add --dry-run ...` 预览

3. 给用户看预览，确认

4. 执行：`mcp add` → `mcp enable --scope both` → 配 env（如需）→ 如果是 OAuth 类的再 `mcp oauth start`

5. `zhishi mcp test <id>` 实际握手测试

6. `zhishi reload`

7. 告诉用户："发条新消息我就能用了"



### 配置模型服务（最常见、最有价值）



#### 协议优先级：Anthropic 协议永远先于 OpenAI 兼容



ZhiShi 基于 Claude Agent SDK，原生协议是 Anthropic Messages API。接入第三方 API 时：



1. **Anthropic 协议（最优先）**：原生协议，零转换开销，所有 SDK 能力（工具调用 / 流式 / Extended Thinking）都正常

2. **OpenAI 兼容（兜底）**：服务商只给 `/v1/chat/completions` 时用 `--protocol openai`，过协议桥接层转换，部分高级功能受限



#### 从文档提取配置



**第一步：找 Anthropic / Claude Code 接入板块（优先）**



大多数支持 Anthropic 协议的服务商，会在文档里以「接入 Claude Code」的形式呈现——ZhiShi 和 Claude Code 共享 SDK，所以 Claude Code 的接入方式就是我们最原生的接入方式。



文档里搜：`Claude Code` / `Anthropic` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `/anthropic`。



提取：

- `ANTHROPIC_BASE_URL` → `--base-url`

- 认证方式（Bearer Token vs API Key）→ `--auth-type`

- 模型名称列表 → `--models`



**即使文档同时给了 OpenAI 兼容方式，只要有 Anthropic 方式就用 Anthropic。**



**第二步：实在没 Anthropic 才用 OpenAI 兼容**



搜：`OpenAI 兼容` / `/v1/chat/completions` / `chat completions`。



- API base → `--base-url`（通常 `/v1` 结尾或去掉 `/chat/completions`）

- 加 `--protocol openai`

- `--upstream-format`：多数 `chat_completions`（默认），少数新服务商支持 `responses`



#### Claude Code 环境变量 → CLI flag 映射



| Claude Code 环境变量 | ZhiShi CLI |

|---------------------|------------|

| `ANTHROPIC_BASE_URL` | `--base-url` |

| `ANTHROPIC_API_KEY` | `model set-key` 设置 |

| `ANTHROPIC_AUTH_TOKEN` | 同上，区别在 `--auth-type` |



**`--auth-type` 选择**：

- 文档说设 `ANTHROPIC_AUTH_TOKEN` → `auth_token`

- 文档说设 `ANTHROPIC_API_KEY` → `api_key`

- 两个都设 / 没说清 → `both`（默认，最安全）

- OpenRouter 等特殊服务商 → `auth_token_clear_api_key`



#### model add 完整 flag



```

zhishi model add \

  --id <唯一ID>              # 必填

  --name <显示名>             # 必填

  --base-url <API地址>        # 必填

  --models <模型ID列表>       # 必填，逗号分隔或多次 --models

  --model-names <显示名列表>   # 可选，与 models 一一对应

  --model-series <系列名>      # 可选，默认取 provider ID

  --primary-model <默认模型>   # 可选，默认取第一个 model

  --auth-type <认证类型>       # 可选，默认 auth_token

  --protocol <协议>           # 可选，anthropic(默认) 或 openai

  --upstream-format <格式>     # 可选（仅 openai），chat_completions(默认) 或 responses

  --max-output-tokens <数字>   # 可选（仅 openai），默认 8192

  --vendor <供应商名>          # 可选，默认取 name

  --website-url <官网>         # 可选

  --dry-run

```



#### 免费模型优先策略



很多 Provider 同时提供付费模型和免费模型。`model verify` 会用 `primaryModel` 发一条测试消息——如果用户还没充值，验付费模型会失败。



**策略**：Provider 既有免费也有付费时，把免费模型放在 `--models` 列表第一位，`primaryModel` 自动选中免费模型，验证更易过。**例外**：用户明确说要哪个就用哪个。



#### 完整流程



1. `model list` 看是不是已有内置 Provider

2. 是内置 → 直接 `model set-key`

3. 要新增 → `model add --dry-run ...` 预览

4. 给用户看预览，确认

5. `model add ...` 正式加

6. `model set-key <id> <key>`

7. `model verify <id>`

8. 验证失败按报错排查：

   - 认证失败 → 检查 Key 和 `--auth-type`

   - 模型不存在 → 检查模型名称

   - 余额不足 → 切到免费模型验证

   - 协议不对 → `--protocol` 在 anthropic / openai 之间切

9. 视情况 `model set-default <id>`



