# auto-run 命令行使用文档（1.7.0）

> `zhishi auto-run` —— 无人值守研究循环的 CLI 入口。策略文档见
> `docs/auto-run-policy.md`；示例策略见 `examples/auto-run/`。

## 前置条件

1. **应用在跑**：CLI 经 `--port` / `ZHISHI_PORT` / `~/.zhishi/sidecar.port` 连应用 admin API；
2. **环境已登记**：`--env-key` 必须是 `zhishi env list` 里已有的环境 id（docker / VM / ssh）；
3. 可选：`--json` 全局旗标（机器可读输出，脚本用）。

## 命令总览

```bash
zhishi auto-run start    # 发起 run（策略驱动，全程自主）
zhishi auto-run list     # run 记录（含待审声明/报告路径）
zhishi auto-run stop <id>                # Esc 语义终止
zhishi auto-run budget <id> --limit N    # 预算续命（GUI 交互 run）
zhishi auto-run verdict <id> --verdict pass|fail|continue [--note "…"]
                                          # 验收终审（GUI 交互 run 补审）
zhishi auto-run clear [--id <id>] [--workspace <路径>]   # 清终态记录（活跃拒绝）
zhishi auto-run --help   # 完整用法
```

## start —— 一条命令拉起无人值守研究

```bash
zhishi auto-run start [<任务名>] \
  --name <任务名> \          # 或位置参数（两者给一即可）
  --goal <目标> \            # 必填
  --env-key <环境id> \       # 必填（zhishi env list 查看）
  --criteria "条件1" --criteria "条件2" \   # 必填 ≥1 条，可重复；启动即锁定不可改
  --budget-kind turns|tokens|time \          # 必填
  --budget-limit N \                          # 必填（turns=轮次 / tokens=估算 token / time=分钟）
  [--policy-file <path>] \                    # YAML 策略；缺省 = 内置保守档
  [--workspace <路径>]                        # 缺省 = 服务端工作区
```

**策略参数**：`--policy-file` 不传 = 内置保守档（全暂停点保守停止、达成自动出报告）。策略 schema 见 `docs/auto-run-policy.md`，三个示例档：

```bash
# 保守（缺省等价） / 平衡（原则自决+续命2次） / 全托管（宽限+续命3次）
--policy-file examples/auto-run/conservative.yaml
--policy-file examples/auto-run/balanced.yaml
--policy-file examples/auto-run/full-auto.yaml
```

成功输出：

```
✓ start run-xxxxxxxxxxx
run: run-xxxxxxxxxxx
loopSessionId: ls-xxxxxxxx
```

**单实例闸**：同 workspace 或同 envKey 已有活跃 run → 拒绝启动（先 `stop` 再起）。

## 模型选择

CLI `auto-run start` **没有模型参数，也不计划加**——run 的模型由启动它的 sidecar 按以下顺序继承：

```
run 每轮 invoke → invokePiSession → 无 providerEnv 分支 → resolveLoopModel()
  → 工作区 agent 配置（resolveWorkspaceConfig(agent)，按 --workspace/agentDir 匹配）
  → 全局默认（defaultProviderId → defaultModelId / provider.primaryModel）
```

### 配置步骤（完整流程）

**第一步：给供应商配 API key**

```bash
zhishi model list                      # 看内置供应商（kimi/deepseek/openai/moonshot/通义/智谱/硅基流动…）
zhishi model set-key <providerId> <apiKey>
zhishi model verify <providerId>       # 发一条测试消息验证 key；成功即自动发现该供应商的模型列表
```

内置供应商的 primary model 自动可用；自定义供应商用 `zhishi model add`（`--base-url` 指向
OpenAI/Anthropic 兼容端点）。

**第二步：选默认（全局，影响所有会话含 auto-run）**

```bash
zhishi model set-default <providerId>   # 该 provider 的 primary model 成为全局默认
zhishi status                           # 确认「Default provider」已切换
```

**第三步（可选）：工作区级覆盖（只影响该工作区的 auto-run）**

```bash
zhishi agent list                       # 看工作区 agent 配置（agentId 与 workspacePath 对应关系）
zhishi agent set <agentId> model '"<模型id>"'
    # value 是 JSON 字符串；模型 id 从 zhishi model list 的输出里取（如 "deepseek-v4-pro"）
zhishi auto-run start ... --workspace <该工作区>
```

**生效验证**：启动 run 后模型落 session meta，`zhishi auto-run list --json` 不显示模型，
直接看记录文件 `<数据目录>/auto-runs/<id>.json` 无 model 字段（模型属 sidecar 配置不属
run 记录）；判断实际用的是哪个模型 = 看 sidecar 启动日志的
`resolveWorkspaceConfig (agent): provider=… model=…` 行，或 run 的 loop 线 meta
（`<loop-sessions>/<loopSessionId>.jsonl` 首行的 model 字段）。

GUI 的「选好模型再开始」本质是配置层前置（状态栏切模型写入工作区配置），auto-run 启动时
继承同一配置——CLI 用上面三步达到同等效果。

## list —— 观察面

```bash
zhishi auto-run list [--workspace <路径>] [--json]
```

人类可读输出：一行一 run（状态 / id / 任务名 / 环境 / 轮数 / 报告路径）；GUI 交互 run 的
`awaiting-verdict` 记录附「声明 + 验收条件 × 证据预检」（✓/✗）——这是 CLI 补审的入口。

终态语义：`completed` = 达成（策略 run 带报告路径 `reportDir`；交互 run 为人审通过）；
`stopped` = 终止/保守停止/失败；`running` = 进行中。

## stop / budget / verdict / clear

```bash
zhishi auto-run stop <id>            # Esc 语义；仅活跃 run（running/paused/awaiting-verdict）
zhishi auto-run budget <id> --limit 50   # 续命仅限 paused+reason=budget（交互 run）
zhishi auto-run verdict <id> --verdict pass [--note "复现成立"]
  # 终审仅限 awaiting-verdict（GUI 交互 run）；策略 run 无终审——读报告
  # fail/continue = 注回 loop 线续跑（sidecar 重启后的孤儿只支持 pass/fail）
zhishi auto-run clear                # 清全部终态记录；--id 单条；--workspace 过滤；活跃拒绝
```

## 无人值守脚本模式

```bash
# 一条命令拉起，run 在应用内自主跑完，产物是报告
zhishi auto-run start --name "novo fuzz" \
  --goal "fuzz novo 目标找崩溃" --env-key fuzz-vm \
  --criteria "至少 1 个可复现崩溃" --criteria "崩溃 PoC 落盘" \
  --budget-kind time --budget-limit 120 \
  --policy-file examples/auto-run/balanced.yaml --json

# 轮询终态（脚本里按状态判断）
zhishi auto-run list --json | jq '.data.records[] | select(.status=="completed") | .reportDir'
```

退出码：`0` 成功 / `1` 业务错误（服务端拒绝，错误信息在 stderr）/ `2` 用法错误 / `3` 连不上应用。

## 常见错误

| 现象 | 原因 |
|---|---|
| `Missing required argument: <id>` | 未知组的 positional 被丢弃——id 必须 `--id` 或紧贴命令词（`stop <id>` 可用） |
| `环境 "x" 未登记` | `--env-key` 拼错或未 `zhishi env add` |
| `策略非法: on_stall.action 非法 "ask"` | schema 无 ask——人要在场用 GUI |
| `验收条件 criteria 必填` | `--criteria` 至少一条（可重复） |
| `预算 kind 必须是 turns/tokens/time` | `--budget-kind` 拼错或漏传 |
| `已有运行中的 auto run … 占用` | 同 workspace/envKey 已有活跃 run，先 stop |

## 与 GUI 的关系

CLI 与 GUI 不互通：CLI 的 run 是策略驱动（全程自主、无弹窗），GUI 的 run 是交互模式
（暂停点弹窗、达成终审）——同一个 runner 的两种用法，`verdict/budget` 只服务 GUI 的交互 run。
