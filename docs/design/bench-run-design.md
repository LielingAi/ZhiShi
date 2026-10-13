# 跑分批量执行（bench run）设计稿 —— 1.9.7

> 状态：设计稿 v6.2（2026-10-11，评审中——与 WREN 共同评估）。
> v6.1 → v6.2 修订（终审对账轮）：①修复迭代接缝残留——§2 表格/§3.1/§3.4/
> §3.6 多处仍是 v5 引擎内方案或单分支口径，与 v6 外置定稿 + 双分支矛盾，
> 全部对齐；②修复一处直接自相矛盾——§4 砍单「不做 VPN 跳板机形态」与
> §3.2 分支 B「优先选跳板机」冲突，改写为"误否决回收"；③实质补洞：
> 共享文件系统干扰纪律（互斥闸被绕过后的真实风险）、stale 判定写实化
> （轨迹 mtime/turns 变化率，非语义分析）、参数序约束（stale < 时间盒 <
> 总时限/并发数）、Python 侧测试不进 vitest 快池；④证据口径修正——
> 模型供给分两时代（第二届自带网关 opus 主导 ≠ v1 平台网关 deepseek-flash
> 上榜），策略结论改为"平台网关供什么用什么"；⑤补 CyberPenda Killchain
> 71.43（六域最低）作为选题策略证据。
> v5 → v6 修订：**调度器外置为 Python 脚本，产品代码改动归零**（WREN 拍：
> 参照 cve-autorun-pipeline.py——纯外部 HTTP 客户端已生产验证数百条 CVE）。
> v4 → v5 修订：**bench 镜像不进 bundled-environments 分发通道**（WREN 拍）。
> v3 → v4 修订：**Hosted 打包收敛为环境配方形态**（WREN 拍：环境原生）。
> v2 → v3 修订：**部署拓扑改判**（CyberPenda Hosted 文档）。v1 → v2：锚点
> 从 campaign 改为 auto-run。
> 前置设计：`auto-redesign.md`（1.7.7）、`security_researcher_agent_design.md`
> （D1 思维动手分工 / D14 边界 / D25 harness 自有）。
> 外部输入：TSecBench 接入指引全文 + openapi/v1（2026-10-11 实扒）；
> CyberPenda Hosted 文档与榜单记录（v1 #3，93.82/100）；
> BreachWeave（第二届冠军）/ Cairn（唯一 AK）架构复盘。
> 纪律：本稿评审通过前不写实现代码；每条设计决策标注证据来源。

## 0. 一句话

**跑分 = auto-run 的批量并发形态**；调度器外置为 Python 脚本（移植
cve-autorun-pipeline 的生产控制回路）；部署拓扑按赛制形态二选一
（§3.2 双分支）。**没有新引擎概念，没有编排器。**

### 0.1 第 0 步（先于一切实现，v6 补）

**本稿最大的未验证假设 = 本届初赛的运行形态**（Hosted 镜像上传 vs
VPN 本地跑分——两者拓扑互斥，见 §3.2）。证据现状：CyberPenda Hosted
文档证明的是"镜像上传形态存在"，TSecBench 接入指引证明的是"VPN 本地
形态存在"，本届初赛页面只写了"平台托管运行"四个字。**零成本消除法**：
注册账号 → 看平台的任务创建页/文档 → 形态揭晓。这一步不过，后面所有
构建都是押注。顺序钉死：**账号 → 形态确认 → 闭卷度量（§5.4）→ 构建**。
（不依赖平台的桩闭环 §5.1 与开卷冒烟 §5.3 可与账号注册并行进行。）

## 1. 证据与外部契约（为什么是它）

1. **Hosted 契约已实读**（CyberPenda `docs/tsecbench/README.md`）：上传物 =
   单个 `.tar.gz` Docker 镜像（<3GB）；运行环境 = VPN 隔离网络、**无公网**、
   无 VPN 客户端；平台注入 `BENCHMARK_BASE_URL` + 一次性 `BENCHMARK_TOKEN`；
   模型走平台网关（`.tsecbench.gw`，专用可吊销 key，openai_chat_completions /
   openai_responses / anthropic_messages 三协议）；stdout = 序列化 JSONL
   评测轨迹流；TSecBench 拥有正式计分，容器内一切状态仅诊断用。
2. **openapi/v1 契约**：`challenges / start / submit / close / hint`；
   ≤3 活跃容器；多 flag 逐题推进（`matched_flag_index` 回传）；
   duplicate 幂等；hint 折减；总时限 invalid_state；题目隔离；3 req/s。
   **注意 `container_addr` 是数组**——多地址即多主机题（Killchain 域的形态
   暗示），环境抽象按"一个执行现场 + 多个网络目标"处理（§3.2 skill 写明）。
3. **冠军/上榜实证**：BreachWeave（30s 轮询、≤3 实例、stale 60min 换题、
   终止 = 平台 flag 计数）；Cairn（赢的是纪律与吞吐，非多角色编排）；
   **CyberPenda（v1 #3，93.82）**——deepseek-v4.1-flash 跑出的分，
   域分 Web 98 / Binary 100 / Exploit 100 / **Killchain 71.43（六域最低，
   强佐证"以深吃二进制+利用、以广吃 Web、浅尝 Killchain"策略）** /
   Cloud 100 / Evasion 100，墙钟 ~5.5h；其 Hosted 配置面把 context window 与
   max output tokens 列为一等旋钮（deepseek 指引值 393216/524288——
   与我们 1.9.6 修的注册表值 384K/1M 同一量级）。
4. **模型供给分两个时代，不可混推**（v6.2 修正）：第二届（challenge.zc 时代）
   队伍自带网关/key，opus 系主导；v1（TSecBench 时代）模型由平台网关供给，
   CyberPenda 的 #3 用的是网关上的 `deepseek-v4.1-flash-expires-on-0910`
   （限时评测专用 id——**本届初赛网关供什么模型清单未知，第 0 步一并确认**）。
   策略结论：**平台供什么用什么 + 我们的 1.9.6 输出预算接线直接生效**。
5. **Decide/Execute 分工实证（CyberPenda Hosted）**：Decide 独占题生命周期，
   Execute 只解题与提交候选；leader.lock 心跳 + ledger.tsv 看门狗 + 90s
   派发应答——与我们「调度器管资源、题线管打题」同构，可直接参照。
6. **赛制画像**：v1 旗舰集 63 题六域约 6 小时；XBOW 已饱和只验流程；
   能力度量用闭卷（bctf-2026 / 新题集）。
7. **实现蓝本已有（WREN 的生产系统）**：`E:\cve-harvester\checkWorkFlow\
   cve-autorun-pipeline.py`——auto-run 批量编排的 proven 控制回路，跑过
   数百条 CVE。三条直接迁移的硬教训：①stop 是协作式，必须等 run 真离开
   running 再启动下一条（154 条连坐的实机教训）；②题级产物目录隔离纪律；
   ③同 envKey 互斥闸的存在性被其生产注释实证。判词复核层（jev）不迁移：
   平台 submit 的 correct 响应是更硬的终审。

## 2. 概念归位（不新造轮子）

| 比赛需求 | zhishi 住处 | 关系 |
|---|---|---|
| 单题打穿 | **auto-run**（goal + criteria + 预算，题级时间盒） | 复用，引擎零改动 |
| 终止判据外置 | **调度器侧外部 stop**（v6 定稿） | 轮询平台 flag 计数 → `auto-run/stop`；不动 declare_completion |
| 多题并发 | **bench-runner.py**（外部脚本）+ 3 环境条目（配置层绕过互斥闸） | 引擎零改动 |
| 平台接线 | **bench skill + 轮询器**（均赛事件） | 拓扑按 §3.2 双分支 |
| 选题 / 换题策略 | **开局人定（一期）**；LLM planner（二期另立稿） | D1：策略是思维，不硬编码 |
| 跨线共享认知 | **不做**（CyberPenda Hosted 同样关闭 Blackboard） | 题目隔离契约 + 治理哲学 |
| 模型层 | **provider 无关架构直插平台网关** | 1.9.6 maxOutputTokens 接线直接可用 |
| 知识/工具基线 | **离线打包**（Hosted 分支）/ 跳板机预装（VPN 分支） | 对照 CyberPenda `/opt/knowledge` |

## 3. 设计本体

### 3.1 入口与开局

- **分支 A（Hosted）**：开局 = 平台页面环境变量 + Task Goal + Goal Appendix；
  镜像启动即跑，无 GUI/CLI 人交互（赛后凭 stdout JSONL + 落盘轨迹回看）。
- **分支 B（VPN 本地）**：开局 = `python bench/bench-runner.py <args>`
  （argparse 参数同 pipeline 形态）；GUI 全程可观察可介入。
- 开局钉死：题集范围（全量/按域/code 清单）、选题顺序策略（易→难 /
  权重倾斜 / 人给清单）、题级时间盒、stale 阈值、单题预算、模型档位。
  之后零打扰。
- token/key 凭据纪律不变：config 引用（D-T4），不进轨迹/claims。

### 3.2 平台接线（双形态分支——以 §0.1 第 0 步的确认结果为准）

**分支 A：Hosted 镜像上传**（CyberPenda 实证形态）——引擎与调度器都进
镜像，容器内注册 `kind: local` 环境（容器即一次性隔离现场，D14 语义同构）：
- **sidecar 看门狗是必修项**（v6 补）：容器内没有 Tauri 宿主做进程编排，
  sidecar 崩溃 = 整场零分——`bench-entry.sh` 必须带崩溃自动拉起 +
  auto-run 状态恢复（对照 Rust 宿主的健康监控职责）；
- 知识/工具全部离线烤进镜像（<3GB）；stdout JSONL 评测流。

**分支 B：VPN 本地跑分**（接入指引 PROMPT/SDK 形态）——引擎跑在我们
机器上（GUI 可观察、可介入），挂 VPN 的 Linux 跳板机登记为 ssh 环境条目：
- 工具链装跳板机（pentest+pwn 配方语义复用）；
- 无镜像打包工程；调试性与迭代速度全胜——**若形态允许，优先选 B**。

两支共享不变的部分：

- **bench skill**（赛事内容件）：平台契约教学 + 提交纪律（候选即试、
  duplicate 幂等、matched_flag_index 推进剩余 flag、hint 折减权衡挂
  stale 信号——卡住到阈值才值得花那 10%）+ **多地址语义**（container_addr
  数组 = 多主机题，按攻击链顺序推进，跳板机/local 执行不变）。
- **轮询器**（机制，非 LLM）：30s tick 读题表（令牌桶 3 req/s）；
  状态快照供终止判据与调度决策读取。不做判断，只搬状态和执行资源规则。
- **题级产物隔离**：`/workspace/<题code>/`（pipeline 纪律）。
- **共享现场干扰纪律**（v6.2 补）：互斥闸被 3 条目绕过后，3 条题线共享
  同一文件系统（分支 A 同容器 / 分支 B 同跳板机）——写操作只进
  `/workspace/<题code>/` 与 `mktemp -d`，**禁止写共享路径**；监听端口动态
  分配（不写死 4444 这类）；bench skill 里写明该纪律。

### 3.3 终止判据（调度器侧，引擎零改动）

auto-redesign 现行语义「判定权在 harness，陈述权在模型」保持不动——
本稿把判定数据源外置到**调度器**而非引擎：

- `declare_completion` 语义**不动**（OR、证据预检全保留）；
  `auto-run.ts` 一行不改。
- 调度器 30s 轮询平台题表；某题 `correct_flag_count === total_flag_count`
  → 调度器调 `auto-run/stop` 结束该题线（外部终止，对照 pipeline 的墙钟
  超时停法）。auto-run 的 criteria 写宽松形态（「flag 全部提交正确」），
  真正的终裁判权在平台响应，不在模型声明。
- 题级额外停点（全在调度器侧判定，v6.2 写实化）：
  - **stale**：题线轨迹 jsonl 的 mtime 与 turns 计数在 N 分钟（缺省 60，
    BreachWeave 实证值）内均无变化 → stop。**不做语义级"新进展"分析**——
    朴素信号足够且可测；
  - **题级时间盒**到 → stop（auto-run 既有预算语义）；
  - 平台 invalid_state 持续 → 全局停止并输出报告到 stdout。
- **参数序约束**（v6.2 补）：`stale 阈值 < 题级时间盒 < 总时限 ÷ 并发数`——
  否则 stale 永不先触发，止损语义落空。

### 3.4 调度（外部脚本形态，拓扑随分支）

- **bench-runner.py**（`bench/` 内，Python stdlib 零依赖——pipeline 同款
  技术栈与形态）：控制回路**移植自 `cve-autorun-pipeline.py`** 的生产骨架
  （幂等检查 / wait_run_gone 等真停 / BatchAbort 整批让路 / 逐题状态机），
  题源与验收口径换成 openapi/v1 契约。每题一条 auto-run（经 sidecar
  admin API 启动，`auto-run/start`）。分支 A 在镜像内跑，分支 B 在宿主跑——
  脚本本体分支无关。
- **并发闸 ≤3**（平台硬限，结构性遵守）：注册 **3 个环境条目**
  （分支 A = 3 个 local 条目；分支 B = 3 个指向同一跳板机的 ssh 条目）——
  「同 envKey 互斥闸」（1.7.0 保留件）按 envKey 计数，**配置层放行、
  代码零改动**（其本意是防有状态现场互踩；干扰纪律由 §3.2 共享现场
  纪律条款承担）。
- **回收**：通关/放弃 → close 容器 → 名额给下一题；分支 A 容器被平台
  强杀 = 进程消亡，愈合不在本稿（Hosted 容器生命周期平台持有）。
- **leader 存活纪律**（参照 CyberPenda 实证，分支 A 限定）：调度器心跳落
  `leader.lock`；题线派发后 90s 无应答视为迷失并重派；**调度器在所有
  题线未决时不得结束主循环**。分支 B 有 GUI/人在场，此项降级为日志。
- **题线装配**：题级 goal = bench skill 段 + 题描述 + container_addr +
  开局策略参数；题级产物目录隔离 `/workspace/<题code>/`。

### 3.5 状态机

题级（每题线）：

```
queued ──名额──> running（auto 循环打题）
running ──平台 flag 计数齐──> completed → close 容器
running ──stale / 时间盒──> stopped → close 容器
任意 ──invalid_state 持续──> stopped
```

全局（bench run）：running →（题表耗尽 | 总时限 | 预算耗尽）→
completed / stopped。无 paused。

### 3.6 Hosted 打包（仅分支 A；= 赛事工程件，不进配方分发通道）

zhishi 是环境原生（D10/D11）：Hosted 镜像的正确读法 = **一个环境配方形态
的工程件**——复用 `bundled-environments/` 的组织约定（Dockerfile + setup
+ SKILL.md 三件套），但**不进 bundled 分发通道**：bundled 配方会随安装包
播种到所有用户的 `~/.zhishi/environments/`（bump ENVIRONMENT_RECIPES_VERSION
触发补种），赛事镜像是赛期工程件、赛后退役，普通用户不该收到它。
落 `bench/`（仓库根目录新目录，自包含，赛后整体归档/删除零残留）。
引擎进容器后注册 `kind: local` 环境（D27「会话必须锚定环境」不变；容器
即一次性隔离现场，D14 边界语义同构——出向净化照跑，界内全自动）。

配方层叠（复用格式约定，零新管线）：

| 层 | 内容 | 来源 |
|---|---|---|
| 基座 | pentest 配方为底叠 pwn 工具链（gdb/pwntools 族）——Web 25% + 二进制 15% + 利用 15% 三域工具链现成；**需新增**：内网穿透组（chisel/frp/proxychains，Killchain 20%）与云/对抗面（15%+10%，初赛期按知识包补方法、工具按需） | `bundled-environments/pentest/` + `pwn/` 语义复用（引用其 Dockerfile 工具段，不改原配方） |
| 引擎层 | Linux x64 Node（bundled nodejs linux 变体）+ server-dist.js（esbuild，pi 1.1.0 内嵌）+ sqlite-runtime linux ABI 预编译件 | 既有构建链 |
| 知识层 | intel.db（裁剪）+ bundled-domains + bundled-expert + skills——**无公网，全部离线** | 对照 CyberPenda `/opt/knowledge`（HackTricks 子集 + 词典） |
| 入口层 | `bench-entry.sh`：读 env 注入 → 起引擎 headless + **看门狗**（§3.2 分支 A）→ 跑 `bench-runner.py`；stdout = JSONL 评测轨迹流，stderr = 运行日志（契约照 CyberPenda） | 本稿新增 |

体积约束：<3GB（CyberPenda 为压线砍掉了全量 seclists——我们同样裁剪
intel.db 与词典）。

### 3.7 产出与收口

- 赛后材料 = stdout JSONL 评测轨迹 + 题线落盘——漏洞挖掘赛道的
  「AI 贡献过程记录」免费产出。
- 观察面（赛后）= 本地 Local Mode 复跑 + 轨迹回放通道（既有件）。

## 4. 反例与砍单（先写死，防 scope 蔓延）

- **不锚定 campaign**（v1 已否）：打题无"盲跑基座 + 信号破冰"分工。
- **不做 LLM planner**（一期）：选题策略开局人定；二期另立稿。
- **不做跨线共享黑板 / claims 全局段**：题目隔离契约 + CyberPenda Hosted
  实证（Blackboard 在 Hosted 下关闭）。决赛 AI-KOH 另立稿。
- **不做新编排器 / 通用工作流引擎**；**不动 delegate_task 语义**；
  **不动引擎主干**（工具面/边界/turn 语义零改动）。
- **不做 Observer 角色 / 多模型竞争上岗**（一期单模型档位；CyberPenda 的
  Pi 多模型槽是二期候选，不进本稿）。
- **误否决回收记录**（v6.2）：v2 砍单「不做 VPN 跳板机形态」是在误判
  "Hosted 唯一形态"前提下的——v6.1 起 VPN 本地复活为分支 B 且优先；
  砍单记录改写以示因果链（当时的否 = 对单宿主 VPN 拓扑的否，不是对
  跳板机形态的否）。

## 5. 验收实验（先于实现锁定判据）

0. **第 0 步**（§0.1）：账号 + 形态确认 + 网关模型清单——免费，先行。
1. **本地桩闭环**（不依赖平台，可与 0 并行）：fake bench API（内存题集 +
   本地 docker 靶机）驱动全流程；断言：3 并发闸、duplicate 幂等、stale
   换题、invalid_state 全局停止、题级目录隔离。（Python 侧桩断言独立跑，
   **不进 vitest 快池**——v6.2 修正口径）
2. **Local Mode 验证**（分支 A 才需要，照 CyberPenda 模式）：同一镜像在
   宿主挂 VPN 跑通 list/start/submit/close——不解题，只验契约与网络拓扑。
3. **开卷冒烟（XBOW/Cybench 本地）**：≥5 题零人工介入；断言题线独立收敛、
   提交闭环、轨迹完整。**只验流程不验能力**（XBOW 已饱和）。
4. **闭卷度量**（bctf-2026，账号到手后）：采样 ≥10 题出通过率 / 单题耗时
   中位 / 单题成本。门槛（与 WREN 共同拍板）：Web easy/medium ≥40% 且
   单题中位 ≤30min 才继续投入主赛。
5. **稳定性压测**：3 并发 × 连续 3 小时零假死（1.9.6 修复的实战验收；
   分支 A 含看门狗拉起演练）。

## 6. 代码改动面

| 文件 | 改动 |
|---|---|
| 新：`bench/`（仓库根，自包含） | 赛事工程件：Dockerfile（分支 A）+ setup + bench skill + `bench-entry.sh` + `bench-runner.py`。**不进 bundled 分发通道、不进 tauri resources、不 bump 配方版本**；赛后整体归档 |
| ~~`loop/auto-run.ts`~~ | **零改动**（v6 定稿）：终止由调度器外部 stop 实现；互斥闸由 3 环境条目配置层绕过 |
| ~~`loop/bench-runner.ts`~~ | **不落引擎**（v6 定稿）：调度器 = `bench/bench-runner.py`（Python stdlib，零依赖），控制回路移植自 `cve-autorun-pipeline.py` 生产骨架 |
| ~~`boundary.ts`~~ | **零改动**（v6 定稿）：模型经 env_exec 在环境内 curl 平台 API = 界内动作；出向净化照常生效 |
| ~~`cli/zhishi.ts`~~ | **零改动**（v6 定稿）：本地调试 = 直接跑 `python bench/bench-runner.py` |
| 赛事内容件 | bench skill（分支 A 打进镜像 / 分支 B 赛期装载，不进 bundled 主干） |
| 测试 | Python 桩断言独立跑（不进 vitest 快池）；引擎侧零改动故零新增 |

## 7. 部署注记（不进设计本体）

- 模型：平台网关供什么用什么（证据 §1.4）；context/output 旋钮用 1.9.6
  接好的注册表值（deepseek 384K/1M，与 CyberPenda 官方指引
  393216/524288 同量级）。
- 打包链路（分支 A）参照 CyberPenda：GitHub Actions `Build Bundle` 工作流 +
  `COMPONENTS.txt` 版本清单 + sha256 校验。
- 智子赛道（本地模型 + DGX Spark ARM64）与决赛 AI-KOH 均不在本稿。
