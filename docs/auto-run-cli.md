# auto-run 命令行使用文档（1.7.7）

> `zhishi auto-run` —— 无人值守研究循环的 CLI 入口。语义与设计见
> `docs/design/auto-redesign.md`（三输入四停点；策略文件已删除，本稿取代
> 1.7.0 版）。

## 一句话语义

auto 与 GUI 交互轨迹同构：**设定目标 + 1-N 条验收条件（任一满足即达成）+ 强制超时**。未达成、未到超时，就一直继续——模型没有自我退出权，它说"不可行"只是轨迹内容。停点只有四个：条件命中（harness 证据确认）、强制超时、研究员 Esc、API 连击死亡。

## 前置条件

1. **应用在跑**：CLI 经 `--port` / `ZHISHI_PORT` / `~/.zhishi/sidecar.port` 连应用 admin API；
2. **环境已登记**：`--env-key` 必须是 `zhishi env list` 里已有的环境 id；
3. 可选：`--json` 全局旗标。

## 命令总览

```bash
zhishi auto-run start     # 发起 run（三输入 + 可选空转话术）
zhishi auto-run list      # run 记录（状态/轮数/终态原因/loopSessionId）
zhishi auto-run stop <id> # Esc 语义终止
zhishi auto-run clear [--id <id>] [--workspace <路径>]   # 清终态记录（活跃拒绝）
zhishi auto-run --help
```

## start

```bash
zhishi auto-run start --name <任务名> \
  --goal <目标> \                    # 必填
  --env-key <环境id> \               # 必填（zhishi env list 查看）
  --criteria "条件1" --criteria "条件2" \   # 必填 ≥1 条，可重复；OR 语义：任一满足即达成
  --budget-kind turns|tokens|time \          # 必填
  --budget-limit N \                          # 必填（turns=轮次 / tokens=估算 token / time=分钟）
  [--stall-prompt "…"] \                      # 可选：空转推进话术（缺省 = 内置通用话术；空串 = 关闭）
  [--workspace <路径>]                        # 缺省 = 服务端工作区
```

成功输出：

```
✓ start run-xxxxxxxxxxx
run: run-xxxxxxxxxxx
loopSessionId: ls-xxxxxxxx
```

**单实例闸**：同 workspace 或同 envKey 已有活跃 run → 拒绝启动（先 `stop` 再起）。

## 终态语义

| 终态 | 触发 | 含义 |
|---|---|---|
| `completed` | declare 宣称达成的条件经 harness 证据预检命中（任一条件，OR） | 达成 |
| `stopped` | 强制超时耗尽 / 研究员 Esc（`stop`） | 未达成，正常收束 |
| `exited` | provider/API 故障连续 5 次（循环无法运转） | 基础设施死亡，修好可重跑 |
| `running` | —— | 进行中 |

没有 paused、没有 verdict 终审、没有 budget 续命、没有 checkpoint、没有自动报告。

## 结束之后看什么（交付物）

结束后没有报告文件，交付物全部来自既有机制（设计稿 §4b）：

| 交付物 | 位置 |
|---|---|
| 轨迹文件（全程消息/工具调用，可回放） | `<数据目录>/loop-sessions/<loopSessionId>.jsonl` |
| 研究事件（research_log 留痕） | memory.db `research_events`，`zhishi research list` |
| 研究档案（H/V/C/Q/R#） | `<loop-sessions>/<loopSessionId>.archive.json`，`zhishi archive list` |
| run 记录 | `<数据目录>/auto-runs/<runId>.json` |
| 环境内产物 | 环境 `/workspace`，自行提取 |

## list / stop / clear

```bash
zhishi auto-run list [--workspace <路径>] [--json]     # 一行一 run（状态/id/任务名/环境/轮数/loopSessionId/终态原因）
zhishi auto-run stop <id>           # Esc 语义；仅活跃 run
zhishi auto-run clear               # 清全部终态记录；--id 单条；--workspace 过滤；活跃拒绝
```

退出码：`0` 成功 / `1` 业务错误 / `2` 用法错误 / `3` 连不上应用。
