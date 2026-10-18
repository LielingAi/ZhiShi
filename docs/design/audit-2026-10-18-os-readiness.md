# OS 就绪度审计：实现面 + 文档面（2026-10-18）

> 目的：为"zhishi 作为 OS 还缺什么"的讨论立**事实底账**——先审计全部实现与
> 文档的当前态，再谈方向。方法：本会话第一手实现认知 + 定点核验。
> 关联：`audit-2026-10-17.md`（代码质量审计）、`gui-v4-capability-audit.md`（74 项能力）。

## 1. 实现面矩阵（子系统 → 现状 → 成熟度 → 留尾）

### 引擎层（src/server/loop/chat-engine.ts，2934 行）
| 件 | 状态 | 留尾 |
|---|---|---|
| turn 生命周期/busy 闸/steering 队列 | ✅ 稳定（chain-audit 修过） | — |
| **多引擎注册表**（P3b：engines per line + per-actor 指针 + 空闲回收） | ✅ 2.0.2 busy 安全切换后能力完整兑现 | 引擎无暂停/恢复、无优先级 |
| 中断五档（Esc/steering/rewind/rollback/attach） | ✅ | — |
| 决策/越界 ask/署名 | ✅ | 无跨线审计轨迹视图 |
| 档案（实体/链/纠正/挂证据 archive/op） | ✅ 1.9.20 起 GUI 可达 | — |

### 工具层（17 工具 + code_query）
env_exec / env_bg / delegate_task / research_archive / research_log / request_decision / declare_completion / **code_query（1.9.10，joern CPG，E2E 三问实校）** —— 全绿。delegate 的白名单与名册同源。

### 记忆层
research_events → 域蒸馏 → 逐 turn 注入；Claim 治理；expert.db 判据库 + harness 邻域注入；上下文压缩（指针块+recall）。**成熟，无留尾**（console 收敛计划见 10-17 审计 §9）。

### 环境层（src/server/environment/）
registry/lifecycle（up/down/rebuild/reset/rm **幂等 2.0.1**）/discover/准入闸（**面板同步 2.0.1**）/快照回滚/传输（extract/push/**xfer 2.0**/put-file/get-file）/**台账治理（merge/prune 2.0）**/peek。**当前代最全的子系统**。

### 战役（campaign runtime）
状态机（running/plateau/triaging/deepening/paused）+ 信号源 + 介入回合（并发闸 1）。✅ 观察面=任务页签对象卡。留尾：**无 envKey 字段**（GUI 经 line.list 反查归属——能 work 但数据面绕）。

### auto-run
引擎/策略 YAML/CLI 自立/一机多 run（同 envKey 互斥）/GUI 观察卡 + AutoRunStream/终态全局回执/环境任选（2.0）。✅ 成熟。

### GUI（v4 骨架 + 2.0 多环境）
正门/menubar/会话流（**流式纯文本 2.0.2**）/检查面板四页签/命令中枢/回执双轨/Markdown 渲染/环境面板/状态栏任务栏段/历史线/设置。**三修后实机验证通过**。留尾：虚拟滚动在超长流上的 measure 开销未压测。

### 团队面（1.8.7）
角色三档/双线制/署名/文件传输/SSE 按线分流。✅ 但**单人零负载**——存在价值绑定"团队方向还做不做"。

### Rust 壳
sidecar 生命周期/版本化 WebView2 缓存（1.9.19）/pty 终端/单实例。**稳定**。

## 2. 文档面矩阵（状态核验 2026-10-18）

| 文档 | 状态 | 漂移点 |
|---|---|---|
| `README.md` | ✅ **2.0.0 重写后现行**（荣耀保留、数字对齐） | — |
| `CHANGELOG.md` | ✅ 到 2.0.2 | — |
| `CLAUDE.md` | ⚠️ 未逐行核验 | 开发命令应仍有效（本轮全部用过） |
| **`docs/roadmap.md`** | ✅ **已重写（2026-10-18 文档债）** | 头部：当前线 2.0.x + 1.0→2.0.2 简史 + "引擎多实例砍单"记录作废更正 + 讨论中项；新增 2.0.x 章节 |
| **`docs/user-guide.md`** | ✅ **已重写（2026-10-18 文档债）** | §2 正门与环境 + 多环境/环境面板/xfer；§3 busy 切换口径；§5 命令中枢/四页签/回执/战役卡；§6 工具面（17+code_query）；§8 auto 任选环境；术语统一（线/假设链） |
| `docs/spec/design-spec.md` | ⚠️ 半现行 | TUI 形态标注退役 ✓、DNA 生效 ✓；但"会话"旧术语与现"线"并存 |
| `docs/design/multi-env-design.md` | ✅ v4 现行 | M4 标注"挂起"——实际环境面板已落地（文档未回写） |
| `docs/design/gui-v4-skeleton-design.md` | ✅ 现行 | S1-S6 全落地 |
| `docs/design/gui-v4-capability-audit.md` | ✅ 底账 | — |
| `docs/auto-run-policy.md` / `auto-run-cli.md` | ✅ 随版本维护 | — |
| `docs/design/audit-2026-10-17.md` | ✅ 现行（含真链记录） | — |
| 历史设计稿（1.1.x~1.8.7 各篇） | ✅ 历史归档 | 术语旧，无碍 |
| `docs/design/bench-run-design.md` | ⚠️ TSecBench 工程件 | 参赛搁置中 |

**文档面结论：代码已走到 2.0.2，叙事文档停在 1.4 时代**——roadmap 和 user-guide 是两大重写件。

## 3. OS 原语缺口（收编讨论，按真实工作价值排序）

| 梯队 | 缺口 | 对应 OS 原语 |
|---|---|---|
| **一** | 线间通信/信号（A 完成→自动递 B）；统一命名空间（`@线:路径`/`@战役` 皆可寻址） | IPC + 文件系统 |
| **二** | 线暂停/恢复 + 优先级；系统日志/审计视图 | 进程调度 + 可观测 |
| **三** | 资源计量（docker stats）、cron 面、设备事件流、优雅关停、第三方扩展 | 设备/定时器/电源/包管理 |

## 4. 供讨论的问题清单（基于以上事实）

1. **文档债先还还是功能先行？** roadmap/user-guide 重写是纯文档工作（约半天），但与"下一步做什么"强耦合—— roadmap 重写本质是**路线图拍板**。
2. **团队方向**：角色三档/双线制的存在价值系于此。冻结则②的可拆性解锁（见 10-17 审计）。
3. **AI 角色收敛**（10-18 讨论）：概念上"角色已死、名字留作索引"——教学段/名册措辞低危正名，做不做。
4. **第一梯队功能**（线间信号 + 统一命名空间）：这是"多环境分工→协作"的最后一块，立不立项。
5. **战役数据面小债**：campaign 记录补 envKey（消除 GUI 反查绕路）——顺手项。

## 5. 文档债清偿记录（2026-10-18，WREN 拍板"文档债先"）

- `roadmap.md`：头部重写（当前线 2.0.x / 全代简史 / 砍单记录作废更正 / 讨论中项），新增 2.0.x 章节
- `user-guide.md`：§2 正门与环境 + 多环境；§3 busy 切换；§5 命令中枢/检查面板/回执/战役卡；§6 工具面；§8 auto 环境任选；术语统一 sweep（7 处 + 参考行）
- `multi-env-design.md`：M4 挂起 → 已落地（环境面板，三轮真机反馈定型）
- 历史稿（1.7.3-gui 等）保留原样——版本设计档即历史

未动：§4 问题清单仍待拍（文档债只是让路线图/指南恢复可信，不改变议题本身）。