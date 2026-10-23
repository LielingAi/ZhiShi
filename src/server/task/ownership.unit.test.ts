/**
 * 任务调度归属（2.0.8）：Rust 已退场，缺省归 Node。
 *
 * 历史：2.0.8 之前缺省是 rust（迁移期保守，怕双跑）。Rust 的调度启动删除后，
 * 缺省翻成 node —— 探测"谁在场"的做法会把可文档化的操作约束变成竞态判断。
 */
import { describe, expect, it } from 'vitest';

import { taskSchedulerOwner } from './ownership';

describe('taskSchedulerOwner', () => {
  it('未设置 → node（Rust 已退场，sidecar 是唯一调度者）', () => {
    expect(taskSchedulerOwner({})).toBe('node');
  });

  it('空串/纯空白同样按未设置处理', () => {
    expect(taskSchedulerOwner({ ZHISHI_TASK_SCHEDULER: '' })).toBe('node');
    expect(taskSchedulerOwner({ ZHISHI_TASK_SCHEDULER: '   ' })).toBe('node');
  });

  it('显式 node / rust / off 原样采纳（大小写与空白不敏感）', () => {
    expect(taskSchedulerOwner({ ZHISHI_TASK_SCHEDULER: 'node' })).toBe('node');
    expect(taskSchedulerOwner({ ZHISHI_TASK_SCHEDULER: ' RUST ' })).toBe('rust');
    expect(taskSchedulerOwner({ ZHISHI_TASK_SCHEDULER: 'off' })).toBe('off');
  });

  it('rust：过渡期降级（还要跑旧 Tauri 安装包时用）', () => {
    // 这条值的唯一用途：让 Node 让位给旧应用的调度器，避免双跑。
    expect(taskSchedulerOwner({ ZHISHI_TASK_SCHEDULER: 'rust', ZHISHI_MANAGEMENT_PORT: '34567' })).toBe('rust');
  });

  it('非法值 → 回落 node 并 warn 一次（不因手误把调度关掉）', () => {
    expect(taskSchedulerOwner({ ZHISHI_TASK_SCHEDULER: 'bogus' })).toBe('node');
  });

  it('有 ZHISHI_MANAGEMENT_PORT 也不影响判定（不做探测）', () => {
    expect(taskSchedulerOwner({ ZHISHI_MANAGEMENT_PORT: '34567' })).toBe('node');
  });
});
