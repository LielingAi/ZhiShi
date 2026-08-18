# 环境内长驻进程通道（env_bg）设计底账

> 版本 2026-08-17 · 状态：Phase 1/2 已落地（见 §6.5），Phase 3 待评估 · 性质：核心功能，稳定性优先
> 定调：不拍脑袋。本文是动手前的地基，所有「为什么」都落在这里，审过再写代码。

## 1. 目标与反目标

**目标**：让 agent 能在研究环境里发起长驻进程（fuzz 长跑、监听器、长扫描、C2），发起即返回句柄，随后可问状态、读日志、杀。三通道（ssh / docker）v1 覆盖，guest-exec 后台 v1 不做。

**反目标**（明确不做，防蔓延）：
- 不做宿主侧持久句柄注册表——真相在环境内
- 不做跨 TUI/sidecar 重启的「可靠续跑」承诺——进程活不活由环境说了算，宿主只负责问
- 不做日志落宿主、不做实时流式推送（v1 是拉模型，不是推模型）
- 不改 `env_exec` 的任何现有语义

## 2. 核心设计决策（稳定性论证）

### D1：真相在环境内，宿主零持久状态

```
发起 → 环境内 nohup 后台跑 + /tmp/zhishi-bg/<tag>.{log,pid,exit}
问询 → 每次一条一次性 ssh/docker exec 命令现场查询
```

- 进程活在环境里；TUI 关、sidecar 重启、会话 fork，都不影响「进程还在不在」。
- 任何控制面重连后都能用 `list` 重新发现全部长驻进程——**宿主不持有任何必须持久化的状态**。
- 这消除了最大一类稳定性隐患：宿主 registry 与环境漂移（进程死了 registry 不知道、registry 残留）。

### D2：env_bg 是薄编排层，复用既有 execInEnvironment

所有动作都是「一次性命令」，走现有的 `execInEnvironment`（ssh → `buildSshArgv`；docker → `buildDockerExecArgv`）。**零新增 spawn、零新增传输、零新增连接管理**。blast radius = 新增一个工具 + 一组纯函数，不碰 env_exec 的 I/O 层。

### D3：命令注入安全 = base64，tag 白名单

- 模型的 `command` 不直接拼进远端包装脚本——宿主侧 base64 编码，远端 `echo <b64> | base64 -d | sh`。任何引号/换行/特殊字符都安全，这是标准做法而非自定义转义。
- `tag` 严格白名单 `[A-Za-z0-9_-]{1,64}`——它会被拼进路径与 `kill`/`cat` 参数，白名单从根上堵注入与路径穿越。

### D4：边界规则复用，不新开闸门

`env_bg` 与 `env_exec` 同属「界内动作」，只把工具名加进白名单 + 复用凭据不泄环境（credential-leak 检查 start 的 command）与 env-ready（断网 guest 通道照旧早 deny）。

## 3. 状态模型

环境内目录 `/tmp/zhishi-bg/`：

| 文件 | 内容 |
|---|---|
| `<tag>.log` | stdout+stderr 合并（重定向 2>&1） |
| `<tag>.pid` | 后台 shell 的 pid |
| `<tag>.exit` | 进程退出码（包装脚本退出时写） |
| `<tag>.cmd` | 原命令（list 展示 + 人审计用，v1 写，不读回） |

状态判定（poll 的语义）：

```
running  : .pid 存在 且 ps -p <pid> 活着
exited   : .exit 存在 → 退出码 = .exit 内容
dead     : .pid 在但 ps 无此进程，.exit 也没有（异常消失）
```

`list` 只报「有哪些 tag」（基于 .log 扫描），不承诺死活；死活交给 poll。文档明示：**日志残留 ≠ 进程活着**（环境重启/快照回滚后 .log 会留着，pid 已失效 → poll 判 dead）。

## 4. 工具契约（v1）

一个工具，五个 action：

```
env_bg { action: start|poll|log|kill|list, tag?, command?, offset?, limit? }
```

- `start`：必填 command；tag 可省（缺省 `bg-<ts>-<rand>`）。返回 `started: tag=… pid=… log=…`
- `poll <tag>`：返回 `status: running|exited|dead`，exited 带 `exit=N`；附最近 4KB 日志尾巴
- `log <tag> [offset [limit]]`：返回 `size=…` + 指定切片；缺省 offset=尾部 8KB
- `kill <tag>`：SIGTERM；返回 `killed: pid=…` 或「已不在运行」
- `list`：一行一个 `tag pid status`

约束：`tag` 已占用且其进程活着 → `start` 报「tag 已被占用（先 kill 或换名）」；占位但已死 → 允许复用（清空旧 log）。

## 5. 三通道实现矩阵

| 通道 | start | poll/log/kill/list | 说明 |
|---|---|---|---|
| ssh | nohup 包装脚本 | 一次性 ssh | v1 ✓ |
| docker | 同上（docker exec） | docker exec | v1 ✓ |
| guest-exec（断网 VM） | — | — | **v1 不做**：需 `runProgramInGuest -noWait` + 包装脚本落盘语义，多一层，独立评估；调用时给清晰错误「guest-exec 后台通道待实现」 |

远端包装脚本（ssh/docker 同一份，由宿主组装）：

```
mkdir -p /tmp/zhishi-bg && cd /tmp/zhishi-bg \
&& nohup sh -c 'echo <B64> | base64 -d | sh; echo $? > <tag>.exit' > <tag>.log 2>&1 & echo $! > <tag>.pid
```

## 6. 失败模式清单（逐条进测试）

1. 发起后进程瞬间死 → poll 报 exited + exit code（.exit 兜住）
2. 命令含引号/换行/管道/重定向 → base64 兜住，不破壳
3. tag 注入（`../`、`; rm`）→ 白名单拒收
4. tag 并发占用 → start 拒绝
5. 环境重启/快照回滚 → pid 失效，poll 判 dead，list 仍有残留日志（文档明示）
6. 日志无限增长 → v1 接受（环境可弃，读取永远走 tail+offset 切片，绝不整读）；轮转列为后续
7. ssh 抖动 → 每次操作都是独立一次性连接，失败语义与 env_exec 一致
8. 超长 command → base64 后仍受 shell 单参上限约束；不设额外 cap，文档说明

## 6.5 边界确认步骤（Phase 2 已落地，回归有据可依）

「服务端不盯梢、终态 poll 才可见、跨重连不恢复」是本设计的固有边界。三个可观察事实确认它（真机 TUI，模型走 deepseek）：

1. **不 poll 永远「跑着」**：发 `用 env_bg 后台跑 for i in $(seq 1 5); do echo x$i; sleep 1; done（tag v1），发起后不要再 poll`。进程 5s 后实际已完，但状态行中段仍是 `⛁ … · 跑着`，会话流无退出插行。
2. **poll 一次才翻转**：再发 `env_bg poll v1，看到 exited 报告退出码`。poll 到终态后状态段移除、会话流插入 `⛁ … · exit=0`。
3. **跨重启不恢复**：起一个 60s 进程（tag v2，不 poll）→ Ctrl+C 退 TUI → 重进：状态行无「跑着」；但进程在环境里仍活（另开 `ssh researcher@<地址>` 跑 `ps aux | grep v2` 可证）；回 TUI 发 `env_bg list` 能重新发现——真相在环境，宿主零持久。

代码层锚：`integration.sse-replay.unit.test.ts` 的 `chat:bg-started/finished` 用例钉死「只有 started 登记、只有 finished 移除」，无自动兜底路径。

## 7. 落地点（文件级）

| 文件 | 改动 |
|---|---|
| `src/server/loop/bg-exec.ts`（新） | 纯函数：`buildBgStartRemote` / `parseBgPoll` / `parseBgList` / `parseBgLog` + 编排 `envBgStart/Poll/Log/Kill/List`（薄包 `execInEnvironment`） |
| `src/server/loop/tools.ts` | `createEnvBgTool` + `env_bg` 参数 schema + 结果格式化 |
| `src/server/loop/chat-engine.ts` | `toolNames` 注册 `env_bg`；`runPiTurn` 挂 `createEnvBgTool(entry)` |
| `src/server/loop/boundary.ts` | env-ready / credential-leak 两条规则认 `env_bg`（白名单加名） |
| 测试 | `bg-exec.unit.test.ts`（builders/parsers 纯函数 + 注入 exec 编排）+ `tools.unit.test.ts` + `boundary.unit.test.ts` 增补 |

**不碰**：`env-exec.ts` 的 I/O 层、SSE 契约、TUI reducer/app、`/api/task/poll-background`（SDK 时代遗留，保持原样）。

## 8. 分阶段 rollout（稳定性优先）

- **Phase 1（本文范围）**：纯引擎件——工具 + 纯函数 + 边界 + 单测。TUI 零改动，长驻进程结果走普通工具卡。活体清单：ssh 通道起 `seq` 长跑 → poll 观察 → log 增量 → kill；docker 通道同清单（有 Docker 的机器上）。
- **Phase 2（独立立项）**：呈现合流——状态行静态段 + 进程退出插行，与 subagent 拍肩膀共用注意力模型。需要新增 SSE 事件（进程 start/finish 通知）或轻量轮询，届时单独立项评审。
- **Phase 3（独立立项）**：guest-exec 后台通道。

## 9. 待审问题

1. 工具名 `env_bg`（一个工具五 action）vs `env_exec` 加 `background` 旗标 + 独立 `env_poll`——我倾向前者（白名单更简、模型选型更不易错）。
2. `start` 的 tag 缺省策略：自动生成 vs 强制模型显式命名——我倾向「缺省自动生成」（模型少一个决策，list 也能看到）。
3. 日志 v1 接受环境内无限增长、读取永远切片——是否需要 v1 就加大小上限（我倾向不加，环境可弃）。
