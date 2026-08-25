/**
 * task-conclusions 登记表单测（1.3.2 任务二 #5）——cron 结论按 taskId 登记,
 * task/list 行补 conclusion 的数据源。覆盖:登记/读取/截断/覆盖/清空/无登记 null。
 */
import { describe, expect, it } from 'vitest';

import {
  clearTaskConclusions,
  recordTaskConclusion,
  taskConclusionFor,
  TASK_CONCLUSION_MAX_CHARS,
} from '../cron/task-conclusions';

describe('task-conclusions 登记表', () => {
  it('登记 → 读取;无登记/空串 → null(「没有就 null/缺省」)', () => {
    expect(taskConclusionFor('task-x')).toBeNull();
    recordTaskConclusion('task-x', '  ');
    expect(taskConclusionFor('task-x')).toBeNull(); // 空串忽略
    recordTaskConclusion('task-x', '完成:拿到 flag');
    expect(taskConclusionFor('task-x')).toBe('完成:拿到 flag');
  });

  it('超长结论截断到上限(摘要,全文在 transcript)', () => {
    const long = 'x'.repeat(TASK_CONCLUSION_MAX_CHARS + 100);
    recordTaskConclusion('task-long', long);
    const got = taskConclusionFor('task-long')!;
    expect(got.length).toBe(TASK_CONCLUSION_MAX_CHARS);
    expect(got.endsWith('…')).toBe(true);
  });

  it('同 taskId 覆盖为最近结论;clearTaskConclusions 清空', () => {
    recordTaskConclusion('task-y', '第一次结论');
    recordTaskConclusion('task-y', '第二次结论');
    expect(taskConclusionFor('task-y')).toBe('第二次结论');
    clearTaskConclusions();
    expect(taskConclusionFor('task-y')).toBeNull();
  });
});
