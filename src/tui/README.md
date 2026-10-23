# zhishi-tui（M2b）

Go + Bubble Tea 写的 `zhishi` 终端前端。**只跟 sidecar 讲 JSON，不做业务逻辑**——
会话、turn、工具执行、环境/任务/档案、远端 pty 全在 sidecar 里，这里只负责把
SSE 事件、admin 响应、WS 帧画成人能看的东西。

参考形态：`usestrix/strix` 的 `strix/interface/tui/`（同架构：前端是 sidecar 的瘦客户端）。

## 跑起来

```bash
cd <repo>
ZHISHI_DATA_DIR=<tmp>/data node src-tauri/resources/server-dist.js \
  --port 38002 --agent-dir <tmp>/ws

cd src/tui
go run ./cmd/zhishi-tui --server http://127.0.0.1:38002
```

| 参数 | 缺省 | 说明 |
|---|---|---|
| `--server` | `http://127.0.0.1:7411` | sidecar 地址 |
| `--token` | `$ZHISHI_TOKEN` | 鉴权 token；空 = 不带 Authorization（auth 关闭的本机模式） |
| `--probe` | `false` | 非 TTY 自检：订阅 SSE 3 秒，打印事件计数、块表、画面尾部 |
| `--probe-overlays` | `false` | 非 TTY 自检：四个数据覆盖层各打开一次 |
| `--probe-m2b` | `false` | 非 TTY 自检：`/sessions` + wire 回看全链路（attach 跳过） |
| `--probe-cli` | 空 | 非 TTY 自检：把一条 `/命令` 走完整路径跑一次并打印输出 |

检查：

```bash
gofmt -l . && go build ./... && go vet ./... && go test ./... -count=1
go test ./internal/app -run TestFrameBudget -v          # 虚拟滚动没被拖垮
go test ./internal/app -bench BenchmarkFrame1200x120 -benchtime 3x -run XXX
# 竞态（Windows 上 -race 需要 C 编译器，本机用 mingw 的 gcc）
CGO_ENABLED=1 CC=gcc go test ./internal/app -count=1 -race
```

可选的真服务端测试（默认跳过）：

```bash
ZHISHI_LIVE_ATTACH=http://127.0.0.1:38002 go test ./internal/client -run TestTermDialLive -v
```

## 键位

INSERT 模式——输入框永远聚焦，没有 NORMAL 模式。bubbletea 的 `Key` 只有 `Alt`
一个修饰位，所以**导航一律走 Alt**。

| 键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Alt+Enter` | 换行（Windows 控制台把 Ctrl+J 与 Enter 同码，只有 Alt+Enter 可靠） |
| `Alt+j` / `Alt+k` | 移动 block 光标（移出视口时自动滚动跟随） |
| `Alt+r` / 点块头 | 折叠/展开**工具输出 / 思考**（工具超 3 行、思考超 3 行才折）——光标没动过时作用于最后一块可折叠的块；块头 `▸` 标出该块。助手正文与用户消息永远完整显示 |
| `Alt+y` | 复制当前块正文（OSC52，不支持时落临时文件） |
| `Alt+o` | 外部打开当前块正文（`$PAGER` / 系统默认程序） |
| `Alt+f` | 只看失败块（切换） |
| `Alt+s` | **attach**：全屏接管当前/选中环境的远端 pty |
| `Alt+h` | **历史回看**：选一条线 → 只读回看它的 wire 消息 |
| `Alt+e` | 环境面板：`↑↓` 选、`Enter` 切环境、`s` attach、`d` 停止、`x` 删除（二次确认）、`n` 重命名、`l` 配方清单、`r` 刷新 |
| `Alt+l` | 线面板：`↑↓` 选、`Enter` 切线、`a` 归档/取消、`n` 重命名、`x` 删除（二次确认）、`r` 刷新 |
| `Alt+t` | 任务面板：`↑↓` 选、`Enter` 看详情（描述/工作区/模型/状态历史/文档路径；详情里 `c` 续命、`x` 终止）、`c` 续命、`x` 终止（二次确认）、`r` 刷新 |
| `Alt+a` | 研究档案：按 kind 分组，`↑↓` 选、`Enter` 看详情（全文/链接/反证；详情里 `v`/`c`/`a` 同样可用）、`v` 证实/解决、`c` 纠正、`a` 搁置、`r` 刷新 |
| `↑` / `↓` | 滚动一行（单行输入时归 stream；多行输入时归光标移动） |
| `PgUp` / `PgDn` / 滚轮 | 翻页 / 滚 3 行（`Alt+g` 回底） |
| `Alt+m` / `F2` | 鼠标接管 / 释放：默认接管（滚轮翻历史、点块头），释放后可拖选复制 |
| `Alt+d` | 待答的决策 / 越界审批面板（Esc 收起后用它重开） |
| `Alt+x` | 会话操作：重置 / 回退 / 分叉 / 切模型 / 权限模式（auto ↔ fullAgency）/ 导出研究报告 |
| `Alt+q` | 队列：看纠偏/排队预览，`Enter`/`x` 撤销 |
| `Alt+w` | 自动循环：`n` 新建（表单）、`x` 终止、`r` 刷新；运行中状态行显示 `⛁ 阶段 · 轮 N` |
| `F1` | 键位总表（状态行只留高频键，其余都在这里） |
| `Alt+i` / `Alt+u` | 附加图片（输入或粘贴路径，≤8MB）/ 移除最后一张；状态行显示「图 N」 |
| `Ctrl+F` | 搜索：本会话块 → `Tab` 扩到记忆 / 专家 / 情报（本地边打边搜，远程回车才发） |
| `Ctrl+K` | 动作中心：搜索并**直接执行**动作（attach / 环境 / 任务 / 报告 / 搜索…）；命令模板同样可搜，选中只填入输入框 |
| 输入 `/` | 输入框上方弹命令候选：继续打字过滤，`↑↓` 选，`Tab`/`Enter` 补全，`Esc` 收起 |
| 输入 `@` | 工作区文件补全（两层扫描），`Tab`/`Enter` 接受；发送时命中文件会变成结构化 `refs` |
| `Ctrl+Space` / `Ctrl+@` | 动作层（空壳） |
| `Tab` | 补全（桩） |
| `Esc` | 关**一层**覆盖层（栈空后按键回输入框） |
| `Ctrl+C` | 跑着 → 中断；空转 → 连按两次退出 |

按键路由是**三段式，顺序不能变**（`internal/app/keys.go::Route`）：

```
overlay 栈顶优先 → 全局键（Alt+字母 / Ctrl+K / Ctrl+C / Esc / Ctrl+Space）→ 其余全给输入框
```

## 视觉

低饱和深色 + 一处强调色；终端不支持真彩时 lipgloss 自动降级，层级靠留白和
字形，不靠颜色。

主题用环境变量选，缺省 catppuccin：

```bash
ZHISHI_THEME=catppuccin|gruvbox|rose-pine zhishi
```

配色是**唯一来源**（`internal/style/palette.go`）：块渲染与外壳都从它取色，
加新主题只改一处。

```
zhishi  http://127.0.0.1:7411                                    running
▍ › you
  扫一下 192.168.88.133 的开放端口
▍ ✻ zhishi
  先做端口扫描，再挑指纹明显的服务看版本。
▸ ● Bash  ✓  1.2s
  22/tcp open ssh
╭──────────────────────────────────────────────────────────────╮
│ › 说点什么…   / 命令  ·  Ctrl+J 换行                          │
╰──────────────────────────────────────────────────────────────╯
INSERT  选择  deepseek-flash  ctx 40%  102k/250k  Σ 124k  队列 0
```

- 内容整体左缩进 1 列，不贴终端边框
- 每个块前留一空行；块头 = gutter + 字形（`› you` / `✻ zhishi` / `● tool` /
  `∴ thinking` / `✗ error`）；正文缩进两格
- 折叠只作用于日志型块。工具输出超过 3 行就**整段收起**：正文 0 行，块头里给
  「首行摘要（env_exec 是 exit=N）+ … 还有 N 行（Alt+r）」。一次 turn 里十几个
  env_exec 只占十几行（原来每个 8 行）；工具块之间也不留空行
- 工具首行 `exit=N`（N≠0）会在块头标 ✗——`isError` 之外的第二道判据
- 标题行显示 sidecar 自动生成的会话标题；状态行显示任务形态与后台进程数
- 换行键是 Alt+Enter：Windows 控制台把 Ctrl+J 归一成 Enter（见偏差 5）
- 助手正文走**轻量 markdown**：标题去掉 `#` 变强调色、`- `→`• `、`> `→`│ `、
  行内代码 / 加粗去标记变色、围栏代码块内整体着色。只做「单行可判定」的语法，
  不改行数、不变宽——否则折行与虚拟滚动会算错
- 发送即时回显 `› you`（流里只有助手输出）；权威回放到同一条时本地那条自动删掉
- 输入框是独立圆角面板；候选浮层贴在它上方
- 状态行分成「模式 chip + 数值」和「光标位置 + 提示」两行，窄屏按优先级丢字段

## 选字与复制

**默认不接管鼠标**——终端自己的拖选/复制开箱即用（状态行显示 `选择` 徽记）。

滚轮不会因此失灵：Windows Terminal 在 alt-screen 下把滚轮翻译成 `↑`/`↓`，而
输入框空着时这两个键被借给 stream 滚动（`Update` 的 `ActionScrollLineUp/Down`）。

需要**点块头折叠**或应用内拖选时，按 `F2` 或 `Alt+m` 接管鼠标（徽记消失）：

- 接管后滚轮直接走鼠标事件，点块头立即折叠
- 应用层拖选：按住左键拖过正文 → 松开即复制（OSC52）。没有高亮反显，
  列坐标按字符近似（中文最多少选半个字）
- 再按一次交还终端

`Alt+y` 复制当前块正文，不依赖鼠标。`F2` 是 `Alt+m` 的备用键——中文输入法
开着时 `Alt+字母` 偶尔会被 IME 吃掉。

## 「让人选择」：决策与越界审批

sidecar 发来 `chat:decision-request` / `chat:boundary-ask` 时自动弹面板：

```
╭───────────────────────────────────────────────╮
│ 决策                                          │
│ 9000/tcp 归属不明，怎么处理？                 │
│ ▸ [1] 直接跑 banner 抓取                      │
│   [2] 先查资产库归属                          │
│   [3] 标记为误报跳过                          │
│ c = 自定义应答                                │
│ ↑↓ 选择  Enter 提交  Esc 收起（Alt+d 重开）   │
╰───────────────────────────────────────────────╯
```

- 选项热键 `1..9`、`a..`（按下即提交）；`↑↓` + `Enter` 同样可以
- 决策额外支持 `c` 自定义应答（选项给不出想要的答案时）
- 越界审批没给 options 时默认 `批准 / 拒绝`，第一个即批准
- `Esc` 收起**不作答**：pending 留在服务端，状态行显示 `!N 待答（Alt+d）`
- 提交走 `POST /chat/decision/respond` / `POST /chat/boundary/respond`；
  收到 `chat:decision-resolved` / `chat:boundary-expired` 自动关面板
- 重连时 sidecar 会重放 pending，按 id 幂等（不会弹两次）

未做：GUI 里的「专家依据区」（`expertHits`）与应答备注（`note`）——协议字段已解出来，
面板暂未渲染。

## `/命令` = CLI 子命令

输入框里以 `/` 开头的输入**不进会话**，而是被当成一条 CLI 子命令执行，输出
贴成一个块（标题 `$ zhishi <命令>`，失败标 ✗）。

```
/model list                         →  zhishi model list
/model set-key deepseek sk-xxx      →  zhishi model set-key deepseek sk-xxx
/env add --kind ssh --id fw --host 192.168.88.133 --user root
/help                               →  zhishi --help
```

- 输入 `@` 弹工作区文件补全（拉 `/api/workspace/files` 两层，`Tab`/`Enter` 接受）
- 输入 `/` 就弹候选（`internal/app/slashmenu.go`），继续打字按前缀过滤；候选只
  负责**发现**，没有候选的命令照打也能执行。
- **不做第二份命令表**：TUI 只负责切分与执行，能力边界完全等于 CLI——CLI 新增
  子命令，这里立刻可用；模板删光了也不影响能力。
- Enter 语义：候选项与输入**完全一致**时直接执行；只是前缀（如 `/mod`）时先补全
  成 `/model list `，再按一次才执行。
- 参数按空白切分，支持单/双引号包裹（引号内空白不切）；不支持转义。
- 执行体由启动器经 `ZHISHI_CLI_ARGV`（JSON argv 前缀）注入：npm 形态是
  `node <pkg>/dist/cli.js`，dev 是 `node --import tsx/esm src/cli/zhishi.ts`。
  直接用 `zhishi-tui` 起（没有启动器）会提示缺这个变量。
- 连的还是同一个 sidecar：经 `ZHISHI_SERVER` 环境变量传入，**不进 argv**——
  `env exec <id> -- <cmd>` 的透传语义要求 `--` 之后原样保留。
- 非交互：stdin 置空，交互式子命令（`expert edit` 之类）会立刻失败；单条命令
  上限 180s，`intel update` 这种长任务请去真终端。
- 非 TTY 自检：`zhishi tui --probe-cli "/model list"` 走完全相同的路径。

## 结构

```
cmd/zhishi-tui/main.go       参数、TUI 启动、四个探针
internal/protocol/           Envelope/Event/Snapshot + SSE 行解析
internal/client/client.go    HTTP + SSE 订阅（chat 面）
internal/client/admin.go     admin 面 + /sessions + wire 消息
internal/client/term.go      attach 的 WS 客户端（coder/websocket）
internal/store/              Block 表：按 ID + Version upsert，保插入序
internal/render/             块渲染缓存 + 高度缓存
internal/app/model.go        状态（无 IO）
internal/app/update.go       Update：唯一发 tea.Cmd 的地方 + 归约 + 数据命令
internal/app/view.go         View：虚拟滚动窗口 + 四段布局 + 叠绘覆盖层
internal/app/keys.go         键路由（三段式）
internal/app/overlay.go      覆盖层接口 / 栈工具 / 列表骨架 / 提示空壳
internal/app/overlay_data.go 四个数据面板（环境/线/任务/档案）
internal/app/palette.go      命令面板
internal/app/attach.go       attach 字节泵 runAttachPump + tea.Exec 接管
internal/app/history.go      只读回看：replayWire + 历史列表 + 回看视图
```

Elm 边界：`model.go` 不产生 IO，`view.go` 没有副作用，`Init`/`Update`/
`Overlay.Handle` 只**返回** `tea.Cmd`，执行永远在 update 的调用栈里。
没有包级可变状态：渲染缓存、管理面客户端、opener 都挂在 Model。

### attach（M2b）

契约（`src/server/loop/term-pty.ts` 头注释，权威）：

- `WS /api/admin/environment/term?env=<envKey>`，token 走 `?token=`（WS upgrade
  认 query 兜底）+ `Authorization` 头，两条都发；
- 帧是 **JSON 文本帧**：客户端→`{type:'input',data}` / `{type:'resize',cols,rows}`
  / `{type:'ping'}`；服务端→`{type:'output',data}` / `{type:'exit',code,signal?}`
  / `{type:'error',message}` / `{type:'pong'}`。

接管走 `tea.Exec`（不是 `tea.ExecProcess`——这里没有子进程可起，"进程"就是 WS
泵；ExecProcess 只是 Exec + exec.Cmd 的语法糖，两者机制一样）：bubbletea 先
`ReleaseTerminal` 放出终端，`Run()` 里 `term.MakeRaw(os.Stdin)` → 泵 → `defer`
`term.Restore` → Run 返回后 bubbletea `RestoreTerminal` 重绘。**不清屏、不写
stdout**：结束提示走状态行（`[attach 结束 code=N]` / `已断开 attach（Ctrl-]）`）。

- 退出键是 **两次 `Ctrl-]`（2 秒内）**，`Ctrl-C` 原样透传给远端——attach 是
  "接管远端 shell"，本地抢 Ctrl-C 会让 vim/less 的行为跟远端不一致；
- 尺寸：进入时先发一次；之后 500ms 轮询（Windows 没有 SIGWINCH，只能轮询），
  只有真的变了才发；
- 字节泵 `runAttachPump(attachOpts)` 的全部依赖（`io.Reader`/`io.Writer`/
  `frameConn`/尺寸/时钟）都是注入的，单测用假 conn + `bytes.Buffer` 跑；
- 收尾三种：远端 `exit` 帧 → `(code, nil)`；两次 Ctrl-] → `(-1, errDetached)`；
  `error` 帧 / 连接断 → `(-1, err)`。

### 历史回看（M2b，只读）

`Alt+h` → `GET /sessions` → 选中一条 → `GET /api/loop-session/messages?
format=wire&loopSessionId=<loopSessionId>` → `replayWire` 灌进**独立的 Store**
（live 的 Store/Cursor/ScrollLines 一个都不动）→ 压在列表之上的只读视图。

- `replayWire` 与 live 冷历史重放共用 `applyWireMessage`，不会出现"回看里 tool
  块和 live 长得不一样"；
- 回看视图自己持有 `render.Cache`：块 ID 是 `msg:<n>`，与 live 会话会撞，共用
  缓存会读到另一条线的正文；
- 只保留**最近 200 条**，超出显示"仅显示最近 200 条（该线共 N 条）"；
- 只读：`Enter` 明确回"只读回看：不能发送"，唯一放行的动作是 `y`/`Alt+y` 复制
  当前块，`Esc` 返回列表、再 `Esc` 关闭。

### 数据源（真实字段，对着服务端源码核过）

| 面板/功能 | 调用 | 线上形状（节选） |
|---|---|---|
| 环境 | `POST /api/admin/environment/list` | `{success, data:{environments:[{id,kind,name,host,container,address,user,capabilityDomains[]}]}}` |
| 环境切换 | `POST /api/admin/environment/select` | 请求 `{workspace, selection:{kind:"env",id}}` |
| attach | `WS /api/admin/environment/term?env=` | 见上 |
| 线/回看列表 | `GET /sessions` | `{success, sessions:[{id,title,loopSessionId,lastActiveAt,archived,stats:{messageCount}}]}` |
| 线切换 | `POST /sessions/switch` | 请求 `{sessionId}` |
| 回看消息 | `GET /api/loop-session/messages?format=wire` | `{success, messages:[{id,role,content,timestamp,name?,ok?,kind?,choice?}], totalMessages, truncated}` |
| 任务 | `POST /api/admin/task/list` | `{success, data:[{id,name,status,executor,tags[],createdAt,updatedAt}]}` |
| 档案 | `POST /api/admin/archive/list` | 请求 `{sessionId}`；`{success, data:{archive:{entities:[{id,kind,text,status,links[],against[],needsReview}]}}}` |

切环境/切线成功后统一善后（`Model.afterLineSwitch`）：清空块表（新线重放复用
同一批 `msg:<seq>` id，不清就会命中旧正文）、清上下文用量、`SubGen++` 作废旧
SSE 通道、重新订阅。

### 状态行

```
INSERT  deepseek-flash · ctx 41% · 168k/250k · Σ 12k · 队列 0 · 5m12s · 1 子任务
```

`ctx%` 与 `a/b` **同源**自 `chat:context-usage` 快照（`contextTokens`/
`contextWindow`），`Σ` 才是 `chat:message-complete` 的 usage 累计。窄屏降级
顺序：**子任务 → Σ → 上下文对数 → 截断**。

### 虚拟滚动

每帧只渲染**可见窗口 + 前后各 5 块**：按块高缓存（未渲染时只估算不渲染）定位
视口底边与顶边 → 渲染这一段 → 精确行数切窗；估算偏小时往上多要 24 块重渲染
**一次**。实测（1200 块 / 120 列 / 120 行）：冷帧 1–3ms，稳态 0.22–0.34ms/op，
每帧 `Cache.Block` 44 次；全量渲染对照 12–18ms。

## 范围

**已做（2.1）**

- 会话流：SSE 订阅/断线提示、事件归约、流式增量、工具成败与自量耗时、虚拟滚动
- 阅读：折叠/点块头、只看失败、OSC52 复制、外部打开、Ctrl+F 搜索（本会话 + 记忆/专家/情报）
- 交互：命令面板、`/命令` → CLI 子进程、`@` 文件补全（命中即发结构化 refs）
- 会话操作：reset / rewind / fork / 会话内切模型 / 权限模式 / 导出报告
- 队列：纠偏与 FIFO 预览 + 撤销；待答决策与越界审批面板（Alt+d）
- 面板写操作：任务续命/终止、环境停止/删除/重命名/配方、档案证实/纠正/搁置、线归档/重命名/删除
- auto-run：观察（阶段/轮次/预算）+ 启动表单 + 终止
- 附件：图片按路径附加（base64 直传 images）
- attach（WS + raw mode + 字节泵）、只读历史回看、四个探针

**仍是桩**

- Ctrl+Space 动作层（空壳覆盖层）
- 命令面板里「复制会话摘要」
- Tab 的普通补全（除 `@` 与 `/` 候选之外）

**没做**

- 多线并存视图、重连退避、生成式 UI 标签、列级叠绘、attach 断线重连
- 环境新增/认领（多字段表单，走 CLI）、`archive/op` 举证挂链、报告内嵌查看、运行时主题切换

## 已知偏差（对着服务端源码 + 实跑核过的）

1. **环境面板的 `Enter` 仍是"切环境"，attach 用 `s`。** M2b 需求写的是"面板里
   对选中行按 Enter 也可以 attach"，但 `Enter` 在 M2a 已被接受为"切环境"
   （有测试钉着）。一个键不能既是"换环境"又是"进终端"——误按代价差太远。所以
   面板里用 `s`、全局用 `Alt+s`，语义不混。要改回 Enter 请明确决定。
2. **attach 的终端恢复只能在真终端验。** 本环境没有 TTY：`tea.Exec` 的释放/恢复、
   raw mode、`Ctrl-]` 的真实按键流都跑不了。CI 能验的是**连接契约**：
   `ZHISHI_LIVE_ATTACH=... go test ./internal/client -run TestTermDialLive` 会真连
   sidecar、收 `output` 帧、发 `input` 帧并等到 pty 回显（本机实测通过）。
3. **`golang.org/x/term` 钉 v0.35.0**：最新版要求 go ≥ 1.26，会把模块的 `go`
   指令顶到 1.26 并触发工具链下载。本模块按既定契约停在 `go 1.24.0`，所以取
   最后一个 go 1.24 兼容版。
4. **attach 的结束提示落在状态行**，不是直接写 stdout：attach 结束后终端归
   bubbletea 管，写 stdout 会被紧接着的重绘盖掉（用户等于看不到）。
5. **换行只有 `Alt+Enter` 可靠。** Windows 控制台把 Ctrl+J 归一成 `VK_RETURN`
   （与 Enter 同码），bubbletea 在 Windows 上拿不到 Ctrl 位；`Shift+Enter` 需要
   CSI-u，v1.3 不支持。代码里三个键都收（Unix 终端下 Ctrl+J 仍是 LF），但文档
   只承诺 `Alt+Enter`。
6. **`Ctrl+Space` 上报成 `ctrl+@`**，两个都认。
7. **attach 的 `SetStdin` 拿到的是 bubbletea 的输入流**，不是我们自己的 `os.Stdin`。
   它通常是 `*os.File`（能 raw + 读）；用 `tea.WithInput(自定义 reader)` 时拿不到
   fd，`makeRaw` 会跳过（退化：按键仍能透传，但没有 raw，本地行缓冲会吃掉回车）。
8. **`environment/select` 的真实签名不是 `{id}`**：要
   `{workspace, selection:{kind:"env",id}}`，`workspace` 只能是 `chat:init.agentDir`
   （TUI 没有第二个来源）；没收到就明确提示"workspace 未知"，不发注定被拒的请求。
9. **`task/list` 的 `data` 是数组本身**（不是 `data.tasks`），字段 camelCase；
   它转发 Rust Management API，裸 `server-dist.js` 没有那一层 → 该面板会显示
   加载失败（这正是"失败只画错误行不退出"要兜的场景）。
10. **`environment.mode`/recipe 锚定**：`chat:init.environment.kind` 可能是
    `recipe`，其 `id` 是配方实例 id；attach 端点按环境条目解析 envKey，配方实例
    大概率 attach 不上（服务端会回 error 帧）。TUI 照发，失败如实显示。
11. **历史回看用 `loopSessionId` 拉 wire，列表行主键是会话 meta id**：两者不是
    一回事，所以 `row` 多带一个 `Ref` 字段；没有 `loopSessionId` 的线明确提示
    "无法回看"。
12. **wire 上线是 2000 条护栏**（服务端 `truncated` 标记），客户端再折到 200 条。
13. **线面板不标"当前线"**（meta id 与 loop id 不一一对应，不猜）；当前线 id
    显示在 header。
14. **`-race` 需要 C 编译器**：本机用 `CC=gcc CGO_ENABLED=1`（mingw64 的 gcc），
    否则 `go test -race` 会因缺 `cl` 而 build failed。
15. **attach 断开就回 TUI**，不自动重连（远端 pty 已被服务端回收）。

## README 截图

`assets/tui.png` 是真帧，不是手工拼的样张：`cmd/framegen` 用真实的 `NewModel` + 种子块渲染
104×26 一帧（不连 sidecar），再由脚本做 ANSI → PNG。

```bash
cd src/tui && go run ./cmd/framegen > /tmp/frame.ansi
python scripts/dev/render-tui-frame.py /tmp/frame.ansi assets/tui.png
```

## 下一步

1. attach 断线重连 + 远端尺寸/标题上报（`{type:'resize'}` 已通，标题还缺协议）。
2. 环境面板的"当前环境"标记与环境/线联动（要 `environment/current`）。
3. 任务面板的终止/续命（`task/update-status` + actor 署名）。
4. 重放对账（`msg:` 前缀块与 live 块收敛）。
5. 渲染：真表格/代码高亮、块内搜索、列级叠绘、滚动条位置指示。

### 发送侧（2.1）

- 消息里 `@app/Mail/x.php` 会随 `chat/send` 发成结构化 `refs: [{type:'file',path}]`；
  `@env:<id>` 发 `{type:'env',id}`。只有**与已知文件表精确匹配**或 env 前缀才发，
  其余 token 原样留在文本里（不猜）
- `permissionMode` 由会话面板（`Alt+x`）切换：`auto`（越界要审批）/ `fullAgency`
  （后台全自主，高危），下一条消息起生效
- 图片/附件仍未接：`/api/files/upload` 需要 multipart，TUI 还没有文件选择入口
