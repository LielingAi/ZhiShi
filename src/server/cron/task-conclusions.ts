/**
 * 任务结论登记（1.3.2 任务二 #5）——task/list 行 conclusion 字段的数据源。
 *
 * 任务中心的行数据在 Rust（src-tauri task.rs::Task，无 conclusion 字段，
 * 服务端不可改）；结论在 sidecar 的执行路径上产生：cron execute(-sync) 的
 * invokePiSession 收尾拿到的完成原因（[CRON_TASK_COMPLETE: ...] 的 reason）
 * 或输出文本摘要。本模块把这些结论按 taskId 记入进程内表，handleTaskList
 * 转发 Rust 行时逐行补 conclusion（有结论就带，没有 → null，字段 additive
 * 不破坏现有行）。
 *
 * 纪律：内存表，服务重启即失效（与决策 pending 表同语义）——结论全文仍在
 * 对应 loop 线的 transcript 里，本表只是 list 的即时摘要来源。
 */

export const TASK_CONCLUSION_MAX_CHARS = 200;

interface TaskConclusionRecord {
  conclusion: string;
  updatedAt: number;
}

const conclusions = new Map<string, TaskConclusionRecord>();

/** 截断（结论只给摘要，全文在 transcript）。 */
function trimConclusion(text: string): string {
  const oneLine = text.trim();
  return oneLine.length > TASK_CONCLUSION_MAX_CHARS
    ? `${oneLine.slice(0, TASK_CONCLUSION_MAX_CHARS - 1)}…`
    : oneLine;
}

/** 登记/覆盖某任务的最近结论（空串忽略——没有结论就不写）。 */
export function recordTaskConclusion(taskId: string, conclusion: string): void {
  const trimmed = trimConclusion(conclusion);
  if (!taskId || !trimmed) return;
  conclusions.set(taskId, { conclusion: trimmed, updatedAt: Date.now() });
}

/** 读取某任务的最近结论；无 → null（「没有就 null/缺省」）。 */
export function taskConclusionFor(taskId: string): string | null {
  return conclusions.get(taskId)?.conclusion ?? null;
}

/** 测试/关闭用：清空全部登记。 */
export function clearTaskConclusions(): void {
  conclusions.clear();
}
