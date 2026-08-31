/**
 * 子代理 / 后台任务登记表与 /tasks 面板行装配单测（1.3.1 ③）。
 */

import { describe, expect, it } from 'vitest';

import {
  applyBgEvent,
  applySubagentEvent,
  bgStatusSegments,
  buildTaskRows,
} from './tasks';

describe('applyBgEvent（chat:bg-started / chat:bg-finished）', () => {
  it('started 登记；同 tag 重开不重复', () => {
    const a = applyBgEvent([], { kind: 'started', tag: 'fuzz', pid: 123, commandPreview: 'afl-fuzz …' });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ tag: 'fuzz', pid: 123, status: 'running' });
    expect(applyBgEvent(a, { kind: 'started', tag: 'fuzz', pid: 124 })).toHaveLength(1);
  });

  it('finished 落终态 + exitCode；未知 tag 忽略', () => {
    const a = applyBgEvent([], { kind: 'started', tag: 'nmap' });
    const b = applyBgEvent(a, { kind: 'finished', tag: 'nmap', status: 'done', exitCode: 0 });
    expect(b[0]).toMatchObject({ status: 'finished', exitCode: 0 });
    expect(applyBgEvent(b, { kind: 'finished', tag: 'ghost', status: 'done' })).toEqual(b);
  });

  it('空 tag 忽略', () => {
    expect(applyBgEvent([], { kind: 'started', tag: '' })).toEqual([]);
  });
});

describe('applySubagentEvent（chat:subagent-*）', () => {
  it('started → running；tool-use 累加工具数', () => {
    let list = applySubagentEvent([], { kind: 'started', taskId: 't1', description: '崩溃去重' });
    expect(list[0]).toMatchObject({ taskId: 't1', status: 'running', toolCount: 0 });
    list = applySubagentEvent(list, { kind: 'tool-use', taskId: 't1', name: 'env_exec' });
    list = applySubagentEvent(list, { kind: 'tool-use', taskId: 't1', name: 'env_exec' });
    expect(list[0].toolCount).toBe(2);
  });

  it('finished → completed/failed + 结论摘要 + loopSessionId', () => {
    let list = applySubagentEvent([], { kind: 'started', taskId: 't1', description: 'd' });
    list = applySubagentEvent(
      list,
      { kind: 'finished', taskId: 't1', description: 'd', summary: '去重完成', status: 'completed', loopSessionId: 'loop-9' },
    );
    expect(list[0]).toMatchObject({
      status: 'completed',
      summary: '去重完成',
      loopSessionId: 'loop-9',
    });
    list = applySubagentEvent(list, { kind: 'finished', taskId: 't1', description: 'd', summary: '', status: 'failed', error: 'boom' });
    expect(list[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('finished 先于 started（乱序容错）→ 补登记', () => {
    const list = applySubagentEvent([], {
      kind: 'finished',
      taskId: 't9',
      description: 'late',
      summary: 's',
      status: 'completed',
      loopSessionId: 'loop-1',
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ taskId: 't9', status: 'completed', loopSessionId: 'loop-1' });
  });
});

describe('buildTaskRows（三源合一）', () => {
  it('subagent / bg / server 行装配与 transcriptable 判定', () => {
    const rows = buildTaskRows(
      [{ tag: 'fuzz', status: 'running' }, { tag: 'nmap', status: 'finished', exitCode: 0 }],
      [{ taskId: 'dedup', description: '去重', status: 'completed', summary: '3 个真崩溃', loopSessionId: 'loop-1', toolCount: 4 }],
      [{ id: 'task-a', name: '研究任务', status: 'running', description: 'P1' }],
    );
    expect(rows.map((r) => r.key)).toEqual(['subagent:dedup', 'bg:fuzz', 'bg:nmap', 'server:task-a']);
    const sub = rows[0];
    expect(sub.transcriptable).toBe(true);
    expect(sub.loopSessionId).toBe('loop-1');
    expect(sub.conclusion).toBe('3 个真崩溃');
    const bg = rows[2];
    expect(bg.status).toBe('exit=0');
    expect(bg.transcriptable).toBe(false);
    const srv = rows[3];
    expect(srv.serverTaskId).toBe('task-a');
    expect(srv.transcriptable).toBe(true);
  });

  it('server 行缺 name 时回退 id；缺 id 丢弃', () => {
    const rows = buildTaskRows([], [], [{ id: 'x', name: '' }, {}]);
    expect(rows.map((r) => r.name)).toEqual(['x']);
  });
});

describe('bgStatusSegments（状态栏后台段 ⛁ name×N）', () => {
  it('只统计运行中的，同 tag 计数', () => {
    const segs = bgStatusSegments(
      [
        { tag: 'fuzz', status: 'running' },
        { tag: 'fuzz', status: 'running' },
        { tag: 'nmap', status: 'finished' },
      ],
      [{ taskId: 'dedup', description: '', status: 'running', toolCount: 0 }],
    );
    expect(segs).toEqual([
      { name: 'fuzz', count: 2 },
      { name: 'dedup', count: 1 },
    ]);
  });

  it('全空 → 空段', () => {
    expect(bgStatusSegments([], [])).toEqual([]);
  });
});
