# auto-run 策略文档（1.7.0）

> 策略文件（YAML）是 auto run 的**唯一治理来源**：run 全程自主，无弹窗、无交互；
> 人与 run 的接口只有两处——**开局写策略，结束读报告**。
> 设计稿：`docs/design/1.7.0-policy-design.md`。

## 快速上手

```bash
# 用内置保守档（不传 --policy-file 即用，全暂停点保守停止、达成自动出报告）
zhishi auto-run start --name "hacknote 复现" \
  --goal "在 pwn 环境复现 hacknote uaf 并拿到 shell" \
  --env-key pwn-vm \
  --criteria "拿到 flag" --criteria "PoC 稳定复现 3 次" \
  --budget-kind turns --budget-limit 30

# 用自定义策略
zhishi auto-run start --name "hacknote 复现" ... --policy-file examples/auto-run/balanced.yaml
```

跑完看结果：

```bash
zhishi auto-run list          # completed + 报告路径
```

## Schema（v1，无 ask）

策略是 YAML 对象，五个节都**可缺省**（缺省 = 保守值）；**未知键一律拒绝**（防拼写错误静默降级为保守档）。schema **没有 `ask`**——CLI 不做交互逻辑；人要在场就用 GUI（GUI 的交互弹窗是其原生流程，不走本文件）。

```yaml
on_decision:                  # 方向分歧（模型 request_decision 提请）
  action: stop                # stop | continue
  principles: |               # 仅 action=continue 时注入（多行原则文本，可缺省）
    - 优先推进已证伪链上最近的假设，不开新方向
    - 权衡取舍偏向可复现优于新颖

on_stall:                     # 空转：连续 N 轮无有效研究记录且阶段未推进
  tolerance: 3                # 整数 ≥1
  action: stop                # stop | continue（continue = 清计数再给 N 轮宽限）

on_failure:                   # 同类工具 isError 连击
  streak: 3                   # 整数 ≥1
  action: stop                # stop | continue

on_budget:                    # 预算耗尽
  action: stop                # stop | renew
  renew_limits: []            # action=renew 时：每次续命上限的序列（>0），序列耗尽后 stop

on_declare:                   # declare_completion 达成声明
  report: true                # true = 自动 report/export 出报告 → completed（带 reportDir）
                              # false = 直接 completed，不出报告
```

### 逐节语义

| 节 | 触发时机 | `stop` | `continue` / 其他 |
|---|---|---|---|
| `on_decision` | 模型主动提请方向分歧 | 保守停止（系统不替模型答自己提的问题） | 把 `principles` 作为消息注入 loop 线，模型按原则自行决策；本条提请**一次性处置**（不会每轮重复注入） |
| `on_stall` | 连续 `tolerance` 轮无新增有效研究记录且阶段未推进 | 停止 | 清空连击计数，再给 `tolerance` 轮宽限 |
| `on_failure` | 同类工具连续 `streak` 次 `isError` | 停止 | 继续跑 |
| `on_budget` | 预算耗尽（turns/tokens/time 三档同口径） | 停止（耗尽即停，先做 checkpoint 留现场） | `renew`：按 `renew_limits` 序列逐次自动续命（例如 `[50, 20]` = 第一次续到 50、第二次续到 20），序列耗尽后停止 |
| `on_declare` | 模型 `declare_completion` 宣布全部验收条件达成 | —— | `report: true` 自动出报告 → `completed`；`report: false` 直接 `completed`。**策略路径没有终审**——验收包不建，人读报告下判断 |

### 表外语义（同样由策略路径覆盖）

- **provider-error**（供应商过载/中断/超时）：策略模式下直接保守停止，不提请——无人应答的白等无意义；
- **铁律**：系统只产出**证据与报告**，不判 pass/fail——结论永远在人读报告时形成，不存在「自动通过」；
- 出报告失败（report/export 报错）→ 不阻断 `completed`，日志告警，记录可查；
- **报告落盘 = 策略预授权**（1.7.1）：`report: true` 同时是「报告产物落盘宿主的预声明同意」——无人值守下边界问询无人应答，报告永远出不来；预授权**仅限本 run 报告产物**（落点 = workspace/output/reports），其余越界写仍走边界拦截；
- 策略 run 的终态只有 `running / completed / stopped`——无 paused、无 awaiting-verdict、无僵尸等待。

## 缺省档（CLI 不传 `--policy-file` 时）

与示例 `examples/auto-run/conservative.yaml` 等价：`decision:stop`、`stall:{3,stop}`、`failure:{3,stop}`、`budget:stop`、`declare:{report:true}`。

## 校验规则（启动即校验，非法拒绝启动）

- `action` 按节枚举（decision/stall/failure：`stop|continue`；budget：`stop|renew`）；
- `tolerance` / `streak` 必须是 ≥1 的整数；`renew_limits` 每项 >0；
- `action: renew` 要求 `renew_limits` 非空；
- `principles` 仅 `continue` 时有意义（`stop` 下允许存在，忽略不报错）；
- 顶层和节内**未知键都拒绝**，错误信息带节名与允许的键（例如「on_stall 含未知键 toleranc（允许:tolerance/action）」）；
- YAML 解析失败直接拒绝，错误带解析器信息。

## 与 GUI 交互模式的关系

- `policy` 缺席的 run = **交互模式**：GUI 原生流程一行未改（暂停点弹决策面板、达成弹终审、`verdict` 命令补审照旧）；
- GUI 启动表单不传策略文件（GUI 不强交互就失去意义）；策略系统服务 CLI / 无人值守；
- `zhishi auto-run verdict / budget` 只服务交互模式 run；策略 run 无终审无续命（读报告即可）。

## 落盘与愈合

- 策略解析后随 `record.policy` 落盘（`<数据目录>/auto-runs/<id>.json`），重启后记录可查；
- sidecar 重启愈合：盘上 `running/paused` 统一落 `stopped`（`awaiting-verdict` 保留孤儿终审通道）——策略 run 不产生新的僵尸形态。

## 同环境互斥闸

同一 envKey（研究环境）同时只允许一个非终态 run：不同 workspace 双开同一环境会被拒（「环境 X 已被运行中的 auto run Y 占用」）——同一容器/VM 双开会互相污染快照、文件与进程状态。需要并行就在同镜像上再起一个实例（docker）或克隆分支（VM）。

## 常见错误

| 错误 | 原因 |
|---|---|
| `策略 含未知键 on_desicion` | 拼写错误（应为 `on_declare`）——未知键一律拒绝是防呆设计 |
| `on_stall.action 非法 "ask"` | schema 无 ask——人要在场用 GUI |
| `on_budget.action=renew 要求 renew_limits 非空` | 选了自动续命但没给序列 |
| `on_stall.tolerance 必须是 ≥1 的整数` | 写了 0 或小数 |
| `YAML 解析失败` | YAML 语法错误（缩进/引号） |
