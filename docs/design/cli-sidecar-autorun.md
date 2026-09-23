# 1.8.2 CLI auto-run 自立 + 单机多开

> 状态：已交付（1.8.2）。实现决策：ensure 落 Node CLI 层（`src/cli/sidecar-ensure.ts`），
> Rust 零改动——PATH 的 `zhishi.cmd` 不经过 `cli.rs`，Node 层才覆盖全部入口
> （含 `ZhiShi.exe` 直调）。设计依据全部来自代码事实核查。

---

## 背景（代码事实）

- CLI（`src-tauri/src/cli.rs` → `src/cli/zhishi.ts`）是零状态客户端：所有
  auto-run 命令只是 HTTP 调 `http://127.0.0.1:<PORT>/api/admin/*`，PORT 来自
  `--port` → `$ZHISHI_PORT` → `~/.zhishi/sidecar.port`（`zhishi.ts:1558-1581`）。
- 引擎（auto-run runner / 环境 / expert / campaign）全在 sidecar 进程
  （`src/server/index.ts`，纯 Node，**无 tauri API import**——grep 全命中均为
  注释/路径字符串）。
- sidecar 由 GUI 的 setup 拉起（`sidecar.rs start_global_sidecar`）。PATH 安装
  的 `zhishi` 命令 = `zhishi.cmd` → node `<data>/bin/zhishi`，**不经 Rust
  cli.rs**——ensure 因此落 Node CLI 层。
- 单 run 互斥在 `auto-run.ts:886-900`：conflict 检查"同 workspace **或** 同
  envKey 有 running → 拒绝"。而运行结构早已是多 run：`activeRuns` 是
  `Map<runId, {ctl, record}>`，run 按 rid 落盘、按 loopSessionId 过滤事件
  （1.7.5 已为"同工作区串行 N 条 run"修过事件互串）、愈合 skipIds 全量活跃、
  收官注回 `appendLoopMessages` 有文件锁。
- GUI 假设（`model/auto-run.ts`）：`activeAutoRunOf` 取 list 中**第一条活跃**
  run 显示观察流；`isAutoRunActive` 锁输入框。

## 改动 1：CLI ensure sidecar（已实现）

**语义**：ensure 而非 always-spawn——读 port 文件 → `/health` 活 → 复用；
没有/死 → CLI 自己拉一个 detached sidecar → 写 port 文件。GUI 拉起的 sidecar
照常复用（行为不变）。

`src/cli/sidecar-ensure.ts`（新模块）：

1. 探测 `sidecar.port` + `/health` → 活 → 复用。
2. 自立：node = `process.execPath`（`zhishi.cmd` 烘焙的 bundled node 即安装
   目录 `resources/nodejs/node.exe`）；server 脚本从 resources 布局推导
   （`<res>/nodejs/node(.exe)` → `<res>/server-dist.js`），dev 回落 repo
   `src/server/index.ts`。
3. detached spawn（`detached + stdio ignore + unref + windowsHide`），
   参数与 global 对齐：`--port N`、`--agent-dir <data>/sidecar-cli-agent`
   （global 用 temp——GUI 生命周期内有效；CLI sidecar 长驻孤儿，temp 会被系统
   清理，用 data 目录）、`--no-pre-warm`、`--zhishi-sidecar`（与 Rust
   SIDECAR_MARKER 同串）。
4. 轮询 `/health` 最多 30s → 写 port 文件。
5. 全部失败 → null，zhishi.ts 走原报错路径（文案更新）。

`src/cli/zhishi.ts`：端口解析段在 `!PORT` 时调 ensure（显式 `--port` /
`ZHISHI_PORT` 不 ensure——调用方负责）。

**已知折衷（v1 注释写明）**：GUI 退出删 port 文件后旧 CLI sidecar 变孤儿空转
（不占端口、下次 ensure 起新的、系统重启清理）——不做进程扫描清理。
GUI 启动仍拉自己的 sidecar：CLI 拉 B 后 GUI 启动拉 A 覆盖 port 文件的短暂
双开窗口存在（毫秒级 spawn 竞争外的主因），可接受——CLI 后续命令连 A，B
自然死亡。

## 改动 2：单机多开（已实现）

`src/server/loop/auto-run.ts` `startAutoRun`：

- conflict 检查收窄：**同 envKey 仍拒绝**（环境 = run 的执行现场，两个 loop
  同容器并发操作互相干扰——执行现场互斥保留）；**同 workspace 放开**
  （各 run 有自己的 loop 线/记录文件/事件过滤，结构上互不干扰）。
- 错误文案：envKey 冲突分支保留；删 workspace 分支。
- 其余不动：愈合（skipIds 已全量）、事件过滤（按线）、注回（文件锁）均已就绪。

**GUI 不改**：观察第一条活跃 run（AutoRunStream）、Esc 语义、输入锁——多开
下行为保持（第一条的观察流 + 任一活跃即锁输入，合理）。多 run 轮播/选择器
后续单独立项。

## 不做

- 不做多 sidecar（端口分配/发现重做，复杂度不值）——多开 = 单 sidecar 内
  多 run。
- 不做 sidecar idle 自退与孤儿进程扫描（见改动 1 折衷）。
- 不动 provider 并发——外部配额由 pipeline 运营参数控制。

## 验收

- `auto-run/start` 在无 GUI、无 port 文件的机器上由 CLI 首次调用即拉起
  sidecar 并成功返回 run id；第二个 start（不同 envKey）并行跑。✔（单测：
  ensure 探测/解析/轮询 + startAutoRun 同 workspace 异 envKey 并行放行）
- 同 envKey 第二次 start 仍拒绝（执行现场互斥）。✔
- 全量单测绿（159 文件 / 2405 项）。✔
