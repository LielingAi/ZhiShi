/**
 * 任务调度归属开关。
 *
 * 历史：任务存储 + 调度原本住在 Rust（`task.rs` / `task_scheduler.rs`）。
 * 2.0.8 起下沉到 Node sidecar（S1-S6：存储层 / 读路由 / 写路由 / 调度器 /
 * 执行器 / per-invoke 工作区），**Rust 侧的调度启动已经删除**（
 * `src-tauri/src/lib.rs` 不再调用 `initialize_task_scheduler`）。
 *
 * 2.0.8 之前这里是"缺省 rust 的保守闸"：迁移期两端都能驱动调度，双跑会让
 * 同一个任务被两套节律各 tick 一遍 —— token 翻倍、progress 被并发重写、
 * 状态机互踩（蒸馏弧已经踩过，见 `memory/distill-scheduler.ts`）。
 * 既然 Rust 已退场，缺省就翻成 `node`：**Node 是唯一调度者，不需要探测谁在场**。
 *
 * 剩下的两个值只服务过渡期的显式降级：
 *   - `rust`：万一还要跑一份旧的 Tauri 安装包做对比，让 Node 让位；
 *   - `off`：谁都不调度（只保留手动 `task run`），用于排障或"我只想手动触发"。
 *
 * 为什么不做"探测 Rust 是否活着"：探测会把一个可以写进文档的操作约束
 * （"跑旧应用就设 ZHISHI_TASK_SCHEDULER=rust"）变成代码里的竞态判断
 * （Rust 正在启动时探不到 → 误判 → 双跑）。确定性优先。
 */

export type TaskSchedulerOwner = 'node' | 'rust' | 'off';

/** 已告警过的非法值——同一个坏值只 warn 一次，避免每次调用都刷日志。 */
const warnedInvalidValues = new Set<string>();

/**
 * 谁在驱动任务调度。
 *
 * - 未设置 / 空串 → `'node'`（Rust 已退场，Node 是唯一调度者）；
 * - `ZHISHI_TASK_SCHEDULER=node|rust|off` → 原样采纳；
 * - 非法值 → 回落 `'node'` 并 warn 一次（与缺省一致，不让一个手误把调度关掉）。
 */
export function taskSchedulerOwner(env: NodeJS.ProcessEnv = process.env): TaskSchedulerOwner {
  const raw = env.ZHISHI_TASK_SCHEDULER;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return 'node';
  }
  const value = raw.trim().toLowerCase();
  if (value === 'node' || value === 'rust' || value === 'off') {
    return value;
  }
  if (!warnedInvalidValues.has(value)) {
    warnedInvalidValues.add(value);
    console.warn(
      `[task-ownership] ZHISHI_TASK_SCHEDULER=${JSON.stringify(raw)} 不是 node|rust|off，回落 node（Rust 已退场，缺省由 sidecar 调度）`
    );
  }
  return 'node';
}
