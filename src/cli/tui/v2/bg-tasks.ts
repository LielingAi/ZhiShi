/**
 * bg-tasks (plan §2.12, design §8 拍肩膀模型). Tracks subagent tasks from the
 * chat:subagent-* event family. Two surfaces:
 *   - status-line middle segment: a STATIC "⛁ <desc> · <count>" (no animation).
 *   - finish report: a background row in the session flow with a "要我切过去吗"
 *     tail hook (y → resume switch).
 *
 * Manual surface: /tasks (list panel).
 */

import type { BackgroundTask, SessionState } from './types';

export function registerTask(
  state: SessionState,
  id: string,
  description: string,
): BackgroundTask {
  let t = state.tasks.get(id);
  if (!t) {
    t = { id, description, outputCount: 0, done: false };
    state.tasks.set(id, t);
  }
  return t;
}

export function bumpOutput(state: SessionState, id: string, n = 1): void {
  const t = state.tasks.get(id);
  if (t) t.outputCount += n;
}

export function finishTask(
  state: SessionState,
  id: string,
  conclusion?: string,
): void {
  const t = state.tasks.get(id);
  if (t) {
    t.done = true;
    if (conclusion) t.latestConclusion = conclusion.slice(0, 200);
  }
}

/** Compose the static middle segment for status-line:子任务 + 长驻进程。 */
export function composeBackgroundSeg(state: SessionState): string {
  const parts: string[] = [];
  for (const t of state.tasks.values()) {
    parts.push(`⛁ ${t.description} · ${t.outputCount}`);
  }
  for (const b of state.bgProcs.values()) {
    parts.push(`⛁ ${b.commandPreview.slice(0, 24)} · 跑着`);
  }
  return parts.join('  ');
}
