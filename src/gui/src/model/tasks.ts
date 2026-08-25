/**
 * 子代理 / 后台任务登记表与 /tasks 面板行装配（1.3.1 ③，纯函数）。
 *
 * 事件契约（src/server/loop/chat-engine.ts 广播点）：
 *   - chat:bg-started   { tag, pid?, commandPreview? }
 *   - chat:bg-finished  { tag, status, exitCode? }
 *   - chat:subagent-started   { taskId, description }
 *   - chat:subagent-finished  { taskId, description, summary, status,
 *                               error?, loopSessionId? }
 *   - chat:subagent-tool-use  { subagentId, id, name, input }
 *
 * /tasks 面板 = 三源合一：后台进程（bg）+ 子代理（subagent）+ 服务端
 * 任务中心（task/list）。选中行按来源取详情：
 *   - subagent 带 loopSessionId → GET /api/loop-session/messages（transcript）
 *   - server task → task/get
 *   - bg 行 → 只有事件快照，无 transcript。
 *
 * 纯函数：不 import store / React / client；单测逐事件断言。
 */

// ---------------------------------------------------------------------------
// 登记表条目
// ---------------------------------------------------------------------------

export interface BgTaskEntry {
  tag: string;
  pid?: number;
  commandPreview?: string;
  status: 'running' | 'finished';
  exitCode?: number;
  startedAt: number;
  finishedAt?: number;
}

export type BgEvent =
  | { kind: 'started'; tag: string; pid?: number; commandPreview?: string }
  | { kind: 'finished'; tag: string; status: string; exitCode?: number };

/** chat:bg-started / chat:bg-finished → 后台任务登记表（按 tag 归并）。 */
export function applyBgEvent(list: BgTaskEntry[], ev: BgEvent, now = Date.now()): BgTaskEntry[] {
  if (!ev.tag) return list;
  const existing = list.find((t) => t.tag === ev.tag);
  if (ev.kind === 'started') {
    const entry: BgTaskEntry = {
      tag: ev.tag,
      pid: ev.pid,
      commandPreview: ev.commandPreview,
      status: 'running',
      startedAt: existing?.startedAt ?? now,
    };
    return existing ? list.map((t) => (t.tag === ev.tag ? entry : t)) : [...list, entry];
  }
  if (!existing) return list;
  return list.map((t) =>
    t.tag === ev.tag
      ? {
          ...t,
          status: 'finished',
          exitCode: ev.exitCode,
          finishedAt: now,
        }
      : t,
  );
}

export interface SubagentEntry {
  taskId: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  error?: string;
  loopSessionId?: string;
  toolCount: number;
  startedAt: number;
  finishedAt?: number;
}

export type SubagentEvent =
  | { kind: 'started'; taskId: string; description: string }
  | {
      kind: 'finished';
      taskId: string;
      description: string;
      summary?: string;
      status: string;
      error?: string;
      loopSessionId?: string;
    }
  | { kind: 'tool-use'; taskId: string; name: string };

/** chat:subagent-* → 子代理登记表（按 taskId 归并；tool-use 累加工具数）。 */
export function applySubagentEvent(
  list: SubagentEntry[],
  ev: SubagentEvent,
  now = Date.now(),
): SubagentEntry[] {
  const taskId = ev.kind === 'tool-use' ? ev.taskId : ev.taskId;
  if (!taskId) return list;
  const existing = list.find((s) => s.taskId === taskId);
  if (ev.kind === 'started') {
    const entry: SubagentEntry = {
      taskId,
      description: ev.description,
      status: 'running',
      toolCount: existing?.toolCount ?? 0,
      startedAt: existing?.startedAt ?? now,
    };
    return existing ? list.map((s) => (s.taskId === taskId ? entry : s)) : [...list, entry];
  }
  if (ev.kind === 'tool-use') {
    if (!existing) return list;
    return list.map((s) => (s.taskId === taskId ? { ...s, toolCount: s.toolCount + 1 } : s));
  }
  // finished
  if (!existing) {
    return [
      ...list,
      {
        taskId,
        description: ev.description,
        status: ev.status === 'failed' ? 'failed' : 'completed',
        summary: ev.summary,
        error: ev.error,
        loopSessionId: ev.loopSessionId,
        toolCount: 0,
        startedAt: now,
        finishedAt: now,
      },
    ];
  }
  return list.map((s) =>
    s.taskId === taskId
      ? {
          ...s,
          description: ev.description || s.description,
          status: ev.status === 'failed' ? 'failed' : 'completed',
          summary: ev.summary,
          error: ev.error,
          loopSessionId: ev.loopSessionId,
          finishedAt: now,
        }
      : s,
  );
}

// ---------------------------------------------------------------------------
// /tasks 面板行
// ---------------------------------------------------------------------------

/** 服务端任务中心（task/list）的最小形状（src-tauri task.rs 的 Task）。 */
export interface ServerTaskLike {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
  /** 1.3.2 任务二 #5：cron 结论登记（有结论就带，没有 → null）。 */
  conclusion?: unknown;
}

export interface TaskRow {
  /** 面板内唯一键（含来源前缀，避免三源撞 id）。 */
  key: string;
  /** 来源：bg 后台进程 / subagent 子代理 / server 任务中心。 */
  source: 'bg' | 'subagent' | 'server';
  /** 展示名（tag / taskId / task name）。 */
  name: string;
  /** 描述（子代理 description / server description）。 */
  detail: string;
  /** 状态徽标（运行中/已完成/失败/exit=N/…）。 */
  status: string;
  /** 结论摘要（subagent summary / bg 退出码）。 */
  conclusion?: string;
  /** 可选 transcript（subagent 带 loopSessionId；server 带 id）。 */
  transcriptable: boolean;
  loopSessionId?: string;
  serverTaskId?: string;
}

/** 三源行装配：子代理在前、后台进程次之、服务端任务最后（v19 顺序感）。 */
export function buildTaskRows(
  bg: BgTaskEntry[],
  subagents: SubagentEntry[],
  serverTasks: ServerTaskLike[],
): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const s of subagents) {
    const statusText = s.status === 'running' ? '运行中' : s.status === 'failed' ? '失败' : '已完成';
    rows.push({
      key: `subagent:${s.taskId}`,
      source: 'subagent',
      name: s.taskId,
      detail: s.description,
      status: statusText,
      conclusion: s.summary ?? s.error,
      transcriptable: !!s.loopSessionId,
      loopSessionId: s.loopSessionId,
    });
  }
  for (const b of bg) {
    const statusText =
      b.status === 'running'
        ? '运行中'
        : b.exitCode !== undefined
          ? `exit=${b.exitCode}`
          : '已结束';
    rows.push({
      key: `bg:${b.tag}`,
      source: 'bg',
      name: b.tag,
      detail: b.commandPreview ?? '',
      status: statusText,
      conclusion: b.status === 'running' ? undefined : statusText,
      transcriptable: false,
    });
  }
  for (const t of serverTasks) {
    const id = typeof t.id === 'string' ? t.id : '';
    const name = typeof t.name === 'string' && t.name ? t.name : id;
    if (!name) continue;
    rows.push({
      key: `server:${id}`,
      source: 'server',
      name,
      detail: typeof t.description === 'string' ? t.description : '',
      status: typeof t.status === 'string' ? t.status : '未知',
      // 1.3.2 任务二 #5：行补 conclusion（有结论就带，截断样式照现有
      // TasksPanel 的 tp-conclusion）。
      ...(typeof t.conclusion === 'string' && t.conclusion
        ? { conclusion: t.conclusion }
        : {}),
      transcriptable: !!id,
      serverTaskId: id,
    });
  }
  return rows;
}

/** 状态栏后台段聚合：`⛁ name×N`（只统计仍在跑的；同 tag 计数）。 */
export function bgStatusSegments(
  bg: BgTaskEntry[],
  subagents: SubagentEntry[],
): Array<{ name: string; count: number }> {
  const map = new Map<string, number>();
  const bump = (name: string, n: number) => {
    if (!name) return;
    map.set(name, (map.get(name) ?? 0) + n);
  };
  for (const b of bg) {
    if (b.status === 'running') bump(b.tag, 1);
  }
  for (const s of subagents) {
    if (s.status === 'running') bump(s.taskId, 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count }));
}
