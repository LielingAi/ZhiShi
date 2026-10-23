/**
 * cron 表达式解析（croner）—— 独立叶子模块，调度器与写路径共用。
 *
 * 为什么单独一个文件：`scheduler.ts` 依赖 `ops.ts`（复用状态迁移），所以
 * `ops.ts` 不能反向 import 调度器（depcruise 的 no-circular 是 error）。把
 * 纯解析放在叶子模块，两边都能用。
 *
 * 为什么用 croner 而不是照抄 Rust 的 `cron` crate 方言：Rust 侧必须把 Unix
 * 星期（0/7=周日）翻译成 crate 的 Quartz 编号（1-7），因为 crate 用的是另一套
 * 编号（src-tauri/src/task_scheduler.rs:106-225 那一段就是补丁）。croner 原生
 * 就是 Unix crontab 语义（0 和 7 都是周日，已实测），所以**不需要翻译** ——
 * 而 Unix 才是前端 `CronExpressionInput` / CLI / AI 一直在写的方言。
 *
 * 方言覆盖（已实测）：5 字段 Unix、6 字段（秒在前）、7 字段（带年）、
 * `?` / `L` / `MON-FRI` 这类 Quartz 写法 croner 也接受 —— 与 Rust 侧能吃的
 * 表达式集合基本等同，不会因为换解析器把老任务挡在门外。
 */

import { Cron } from 'croner';

/**
 * 下一步触发时刻（epoch ms）；表达式非法 / 没有下次 → `null`。
 *
 * `from` 显式传入而不取 `Date.now()`：调度器每轮都用注入时钟算下一跳，
 * 测试才能断言确定的时间点。
 */
export function nextCronFire(expr: string, tz: string | undefined, from: number): number | null {
  const trimmed = expr.trim();
  if (trimmed === '') return null;
  try {
    const cron = new Cron(trimmed, { timezone: tz ?? 'UTC' });
    const next = cron.nextRun(new Date(from));
    return next === null ? null : next.getTime();
  } catch {
    return null;
  }
}

/** 校验表达式 + 时区；合法返回 `null`，否则返回错误串（直接给用户看）。 */
export function validateCronExpression(expr: string, tz?: string): string | null {
  const trimmed = expr.trim();
  if (trimmed === '') return 'cron expression is empty';
  try {
    // croner 对非法 IANA 时区在**构造期**抛错（实测），所以这一句同时校验了两者。
    const cron = new Cron(trimmed, { timezone: tz ?? 'UTC' });
    if (cron.nextRun(new Date()) === null) {
      return `no upcoming fire time for cron expression '${trimmed}'`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
