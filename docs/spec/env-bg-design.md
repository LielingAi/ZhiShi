# 环境内长驻进程通道（env_bg）设计底账

> 版本 2026-08-19 · 状态：Phase 1/2 已落地（见 §6.5）；Phase 3（稳定性闭环：登记表落盘 / poll 存活探测 / turn 结束回收杀掉）已定稿并落地（见 §8） · 性质：核心功能，稳定性优先
> **2026-08-26 补（1.3.9 TUI 退役）**：文中「TUI 状态行/退出插行/消费面」等措辞为 TUI 时代历史描述——当前消费方为 GUI（状态栏 ⛁ 段 + 回报卡）。设计本体不变：**D1「真相在环境内，宿主零持久状态」、探测/回收语义、SSE 事件形状全部仍生效**。
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
- Phase 3 补一张**可弃的宿主登记表**（`bg-registry.ts`，落盘但丢得起）：它不是真相，只是「本工作区发起过谁」的账本，供 turn 结束回收杀掉时知道要杀谁。真相应答（进程在不在）永远走环境现场查询（D1 不变）。

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
9. 登记表落盘失败（盘满/权限）→ 原子写失败仅告警，内存态继续——登记表不是真相，丢了只是回收链失明
10. 登记表文件损坏 → 坏 JSON/坏条目逐条跳过，按空表启动，不炸会话
11. 探测通道失败（ssh 断流）→ poll 保守报 running + `probeFailed` 标注，不广播 finished、不回收杀掉——「没法证伪」不等于「证据说死了」
12. 环境重启后 pid 被回收 → 探测/回收命令带 .pid 一致性校验，旧 pid 对不上就不杀，绝不误杀别人进程
13. tag 复用竞态（回收与下个 turn 同名重起并发）→ 回收 kill 按登记 pid + 一致性校验，杀错不了新进程

## 6.5 边界确认步骤（Phase 2 已落地，回归有据可依）

「服务端不盯梢、终态 poll 才可见、跨重连不恢复」是本设计的固有边界。三个可观察事实确认它（真机 TUI，模型走 deepseek）：

1. **不 poll 永远「跑着」**：发 `用 env_bg 后台跑 for i in $(seq 1 5); do echo x$i; sleep 1; done（tag v1），发起后不要再 poll`。进程 5s 后实际已完，但状态行中段仍是 `⛁ … · 跑着`，会话流无退出插行。
2. **poll 一次才翻转**：再发 `env_bg poll v1，看到 exited 报告退出码`。poll 到终态后状态段移除、会话流插入 `⛁ … · exit=0`。
3. **跨重启不恢复**：起一个 60s 进程（tag v2，不 poll）→ Ctrl+C 退 TUI → 重进：状态行无「跑着」；但进程在环境里仍活（另开 `ssh researcher@<地址>` 跑 `ps aux | grep v2` 可证）；回 TUI 发 `env_bg list` 能重新发现——真相在环境，宿主零持久。

代码层锚：`integration.sse-replay.unit.test.ts` 的 `chat:bg-started/finished` 用例钉死「只有 started 登记、只有 finished 移除」，无自动兜底路径。

## 7. 落地点（文件级）

| 文件 | 改动 |
|---|---|
| `src/server/loop/bg-exec.ts`（新） | 纯函数：`buildBgStartRemote` / `parseBgPoll` / `parseBgList` / `parseBgLog` + 编排 `envBgStart/Poll/Log/Kill/List`（薄包 `execInEnvironment`）；Phase 3 加 `buildBgProbeRemote`（存活探测）/ `buildBgReapRemote` + `envBgReap`（回收 kill）/ `knownPid` 探测注入 |
| `src/server/loop/bg-registry.ts`（Phase 3 新） | 宿主登记表：内存 Map + 落盘（`<数据目录>/bg-procs/<工作区哈希>.json`，tmp+rename 原子写，写失败不致命）+ 启动恢复 |
| `src/server/loop/bg-reap.ts`（Phase 3 新） | 回收编排 `reapAllBgProcesses`（注入依赖可测；暂定决策与容错语义见其模块头注释） |
| `src/server/loop/tools.ts` | `createEnvBgTool` + `env_bg` 参数 schema + 结果格式化；Phase 3 加登记表接线（start 登记 / poll 探测 + 终态清登记 / kill 清登记） |
| `src/server/loop/chat-engine.ts` | `toolNames` 注册 `env_bg`；`runPiTurn` 挂 `createEnvBgTool(entry)`；Phase 3 加 `initPiChatEngine` 恢复登记表、turn 收尾 finally 与 `resetPiChat` 两处回收挂载 |
| `src/server/loop/boundary.ts` | env-ready / credential-leak 两条规则认 `env_bg`（白名单加名） |
| 测试 | `bg-exec.unit.test.ts`（builders/parsers 纯函数 + 注入 exec 编排）+ `tools.unit.test.ts` + `boundary.unit.test.ts` 增补；Phase 3 加 `bg-registry.unit.test.ts`（落盘/恢复/原子写失败不致命）+ `bg-reap.unit.test.ts`（回收四态） |

**不碰**：`env-exec.ts` 的 I/O 层、SSE 契约、TUI reducer/app、`/api/task/poll-background`（SDK 时代遗留，保持原样）。

## 8. 分阶段 rollout（稳定性优先）

- **Phase 1（已落地）**：纯引擎件——工具 + 纯函数 + 边界 + 单测。TUI 零改动，长驻进程结果走普通工具卡。活体清单：ssh 通道起 `seq` 长跑 → poll 观察 → log 增量 → kill；docker 通道同清单。
- **Phase 2（已落地）**：呈现合流——状态行静态段 + 进程退出插行。SSE 事件 `chat:bg-started/finished`（`started` 登记、`finished` 移除，`integration.sse-replay.unit.test.ts` 钉死，见 §6.5）。
- **Phase 3（本次定稿并落地）**：稳定性闭环——不再是原草案的「guest-exec 后台通道」（guest-exec 继续不做，见 §5 矩阵）。三条缺口：

### 8.1 登记表持久化（sidecar 重启可恢复）

原状：宿主侧根本没有登记表（`bgProcs` 只在 TUI 内存里，靠 SSE 事件登记）。sidecar 重启后回收链失明，进程变孤儿。

定稿：

- 新建宿主登记表 `bg-registry.ts`：内存 Map + 落盘 `<数据目录>/bg-procs/<agentDir 短哈希>.json`（`app-dirs.ts` 的 `getZhiShiDataDir()`，与 loop-sessions 同目录约定；哈希隔离多工作区 sidecar 互踩）。
- 盘上形状：`{ version: 1, entries: [{ tag, pid, envId, startedAt, commandPreview }] }`——`envId` 是回收时解析环境条目的锚。
- 启动恢复：`initPiChatEngine` → `initBgRegistry(dir)` → restore。恢复只重新纳入回收链（下一个 turn 结束仍能按 tag+pid 回收），**不重播 `chat:bg-started`**（TUI 侧状态行有自己的内存登记，重复广播制造重影）。
- 写入原子：tmp+rename（同 `loop/session.ts` 惯例）；**失败不致命**——写失败仅 `console.warn`，内存态继续。登记表不是真相（D1），丢了只是回收链失明。
- 清除时机：poll 观测到终态 / kill 成功（或进程已不在）/ 回收完成——登记表随进程终结即清。

### 8.2 poll 存活探测

原状：poll 走远端 `.pid/.exit` 现场判定，语义正确；但探测通道失败（ssh 断流）时工具直接 throw，模型看到的是错误而非「探不到」，且登记表里没有可供校验的 pid。

定稿：

- `envBgPoll` 加 `knownPid` 注入（工具层从登记表取 pid）。有 knownPid 时走探测命令 `buildBgProbeRemote`：`kill -0 <pid>`（Windows 用 `Get-Process -Id`）+ **.pid 一致性校验**——先核对 `.pid` 文件仍是登记的 pid，再探测。防环境重启后 pid 被系统回收给别的进程，旧 pid 假活误判。
- 探测三态（逐条进单测）：
  - 活 → `running`（与 Phase 2 语义一致）；
  - 死 → 如实报 `exited`（`.exit` 有码带码；无 `.exit` 报 `dead` 异常消失；`.pid` 文件都没了报 `missing`）——终态一律清登记 + 广播 `chat:bg-finished`；
  - **探测命令本身失败**（ssh 不通/超时）→ `ok:true`、`status:running`、`probeFailed:true`，结果文本标注「探测失败，保守保留 running 登记，不误杀」。不广播 finished、不回收。这是「没法证伪」，不是「证据说活着」。
- 无 knownPid（未登记的 tag）→ 仍走 Phase 2 的 `.pid/.exit` 现场判定，语义不变。

### 8.3 清理策略：回收杀掉（**暂定决策**）

**turn 结束（含 Esc 中断）与会话 reset 时，回收杀掉登记表里所有仍在跑的 bg 进程。**

> 接手者注意：这是暂定决策，不是终态。潜在问题（写在 `bg-reap.ts` 模块头注释，代码即底稿）：
> 1. **误杀长任务**——turn 结束 ≠ 研究结束；fuzz 长跑/长扫描被 turn 边界拦腰杀，进度只留在环境日志，下个 turn 只能重起；
> 2. **研究中断丢进度**——Esc 打断的有时只是模型闲聊，后台有用进程被连坐；
> 3. **替代模型已备好**——「保留续跑 + 认领」：进程在环境里继续跑（D1），新 turn / 重启后的 sidecar 用 tag 认领句柄（`list` 重新发现 + poll 看终态）。登记表落盘已为跨重启认领就位。
>
> 当时选回收的理由：确定性优先——不杀，孤儿在环境里积压吃光资源；杀了，最多重跑一次。若改保留续跑，改动点集中在 `bg-reap.ts` 一处语义，SSE 契约不用动。

定稿细节：

- 挂载点（chat-engine.ts）：
  - turn 收尾：`startPiTurn` 的 `.finally()`（`runPiTurn` 之后、`promotePiQueue` 之前 fire-and-forget）——覆盖正常结束与 Esc 中断（abort 后 runPiTurn 正常走完）；fire-and-forget，kill 失败绝不阻塞 turn 收尾；
  - 会话 reset：`resetPiChat()` 末尾（与 abort 触发的 turn 收尾回收幂等）。
- kill 顺序：先杀（`envBgReap`：主进程 + linux `pkill -P` 直接子进程，不做进程组杀——后台进程与 ssh 会话同组，组杀波及正在执行的其它命令；Windows `taskkill /T /F` 树杀）→ 清登记表与盘上记录 → 广播 `chat:bg-finished`（登记表里还存在的 = 此前没广播过 finished）。
- 容错语义（逐条进单测）：
  - 杀成功 → 清登记 + 广播 `finished(killed)`；
  - `.pid` 对不上（环境重启/tag 复用）→ 不杀，清登记 + 广播 `finished(dead)`；
  - 通道失败（ssh 不通）→ 登记保留（下个 turn 结束再试），不广播 finished——与「探测失败不误杀」同一原则；
  - 环境条目已删 → 够不到，清登记 + 告警（孤儿由环境侧 `env_bg list` 兜底发现）。
- 回收 kill 与用户主动 `env_bg kill` 分开：回收按**登记 pid** + 一致性校验（防 tag 复用竞态杀错新进程）；主动 kill 维持按 `.pid` 现场取值（Phase 1 契约不变）。

### 8.4 SSE 契约与 TUI

`chat:bg-started/finished` 事件形状不变（finished 新增广播路径只用既有 status `killed`/`dead`/`exited`），TUI reducer 零改动；`integration.sse-replay.unit.test.ts` 原用例不动。

## 9. 待审问题

1. 工具名 `env_bg`（一个工具五 action）vs `env_exec` 加 `background` 旗标 + 独立 `env_poll`——已定：前者（白名单更简、模型选型更不易错）。
2. `start` 的 tag 缺省策略：自动生成 vs 强制模型显式命名——已定：缺省自动生成。
3. 日志 v1 接受环境内无限增长、读取永远切片——已定：不加上限（环境可弃）。
4. Phase 3 回收杀掉是**暂定决策**（§8.3）：观察误杀长任务的实损后再定是否转「保留续跑 + 认领」模型；转向前先评审，代码改动点集中在 `bg-reap.ts`。
