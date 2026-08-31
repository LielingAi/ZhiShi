import { describe, expect, it } from 'vitest';

import {
  autoRunRowsOf,
  buildHistorySession,
  filterSessionRows,
  applySessionTitleChange,
  groupSessionRows,
  mergeAutoRunRows,
  normalizeWireMessage,
  parseSessionRow,
  parseSessionRows,
  sortSessionRows,
} from './history';

describe('parseSessionRow（GET /sessions 行归一）', () => {
  it('解析完整行', () => {
    const row = parseSessionRow({
      id: 'm1',
      title: '审计 gzip',
      createdAt: '2026-08-01T00:00:00Z',
      lastActiveAt: '2026-08-02T00:00:00Z',
      loopSessionId: 'loop-1',
      lastMessagePreview: '帮我审 gzip.c',
      stats: { messageCount: 12 },
      pinned: true,
      archived: true,
      envKey: 'env:pwn-vm',
    });
    expect(row).toEqual({
      id: 'm1',
      title: '审计 gzip',
      createdAt: '2026-08-01T00:00:00Z',
      lastActiveAt: '2026-08-02T00:00:00Z',
      loopSessionId: 'loop-1',
      lastMessagePreview: '帮我审 gzip.c',
      messageCount: 12,
      pinned: true,
      archived: true,
      envKey: 'env:pwn-vm',
    });
  });

  it('缺省字段走默认（title 空 → New Chat，false 不落 pinned/archived）', () => {
    const row = parseSessionRow({ id: 'm2', title: '' });
    expect(row).toEqual({
      id: 'm2',
      title: 'New Chat',
      createdAt: '',
      lastActiveAt: '',
      messageCount: 0,
    });
  });

  it('非法形状返回 null', () => {
    expect(parseSessionRow(null)).toBeNull();
    expect(parseSessionRow('x')).toBeNull();
    expect(parseSessionRow({})).toBeNull();
    expect(parseSessionRow([])).toBeNull();
  });

  it('parseSessionRows 过滤非法行', () => {
    expect(parseSessionRows([{ id: 'a' }, null, { title: 'x' }, 'junk'])).toHaveLength(1);
  });
});

describe('排序 / 过滤 / 分组', () => {
  const rows = [
    { id: 'a', title: 'aaa', createdAt: '', lastActiveAt: '2026-08-01T00:00:00Z', messageCount: 1, envKey: 'env:x' },
    { id: 'b', title: 'bbb', createdAt: '', lastActiveAt: '2026-08-03T00:00:00Z', messageCount: 2 },
    { id: 'c', title: 'ccc', createdAt: '', lastActiveAt: '2026-08-02T00:00:00Z', messageCount: 3, envKey: 'env:x', pinned: true },
    { id: 'd', title: 'ddd', createdAt: '', lastActiveAt: '2026-08-04T00:00:00Z', messageCount: 4, envKey: 'env:x', archived: true },
    { id: 'e', title: 'eee', createdAt: '', lastActiveAt: '2026-08-05T00:00:00Z', messageCount: 5, archived: true },
  ];

  it('sortSessionRows：置顶优先，其余按 lastActiveAt 降序', () => {
    const sorted = sortSessionRows(rows).map((r) => r.id);
    expect(sorted).toEqual(['c', 'e', 'd', 'b', 'a']);
  });

  it('filterSessionRows：title + 预览子串匹配', () => {
    const withPreview = [
      ...rows.slice(0, 3),
      { id: 'f', title: 'zzz', createdAt: '', lastActiveAt: '', messageCount: 0, lastMessagePreview: '关键词 flag 在 gzip' },
    ];
    expect(filterSessionRows(withPreview, 'bbb').map((r) => r.id)).toEqual(['b']);
    expect(filterSessionRows(withPreview, 'gzip').map((r) => r.id)).toEqual(['f']);
    expect(filterSessionRows(withPreview, '').map((r) => r.id)).toEqual(withPreview.map((r) => r.id));
  });

  it('groupSessionRows：置顶组 → env 线（宿主最后）→ 归档组', () => {
    const groups = groupSessionRows(rows);
    expect(groups.map((g) => g.key)).toEqual(['pinned', 'env:env:x', 'env:host', 'archived']);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['c']);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['a']);
    expect(groups[2].rows.map((r) => r.id)).toEqual(['b']);
    expect(groups[3].rows.map((r) => r.id)).toEqual(['e', 'd']);
  });

  it('groupSessionRows：showArchived=false 隐藏归档组', () => {
    const groups = groupSessionRows(rows, { showArchived: false });
    expect(groups.some((g) => g.archived)).toBe(false);
  });
});

describe('wire 归一 + 只读回放', () => {
  const wire = [
    { id: '1', role: 'user', content: '审 gzip.c' },
    { id: '2', role: 'assistant', content: '结论：' },
    { id: '3', role: 'assistant', content: '发现越界读。' },
    { id: '4', role: 'tool', name: 'env_exec', ok: true, content: 'flag{read}' },
    {
      id: '5',
      role: 'user',
      content: '决策正文',
      kind: 'decision',
      decisionId: 'd1',
      choice: '继续',
      note: '低危',
      expertRefs: ['E#1'],
    },
    { id: '6', role: 'assistant', content: '按决定执行。' },
    { id: '7', role: 'tool', name: 'env_exec', ok: false, content: 'SIGSEGV at 0x414141' },
  ];

  it('normalizeWireMessage 透传字段 + 类型防御', () => {
    expect(normalizeWireMessage(wire[0])).toEqual({ id: '1', role: 'user', content: '审 gzip.c' });
    expect(normalizeWireMessage({ role: 'tool', name: 7, content: 'x' })).toEqual({
      role: 'tool',
      content: 'x',
    });
    expect(normalizeWireMessage({ role: 'system', content: 'x' })).toBeNull();
    expect(normalizeWireMessage('junk')).toBeNull();
  });

  it('buildHistorySession：重建块（结论聚合 / 工具卡 / 决策块 / 定格 complete）', () => {
    const s = buildHistorySession(wire);
    expect(s.items).toHaveLength(2);
    const [t1, t2] = s.items;
    expect(t1.kind).toBe('turn');
    expect(t2.kind).toBe('turn');
    if (t1.kind !== 'turn' || t2.kind !== 'turn') throw new Error('not turns');
    expect(t1.userText).toBe('审 gzip.c');
    expect(t1.conclusion).toBe('结论：发现越界读。');
    expect(t1.decision).toBeUndefined();
    expect(t1.details).toHaveLength(1);
    const d1 = t1.details[0];
    expect(d1.kind).toBe('tool');
    if (d1.kind !== 'tool') throw new Error('not tool');
    expect(d1.name).toBe('env_exec');
    expect(d1.state).toBe('done');
    expect(d1.signal).toBe('flag 已读取');
    // 决策块
    expect(t2.decision).toEqual({ decisionId: 'd1', choice: '继续', note: '低危', expertRefs: ['E#1'] });
    expect(t2.conclusion).toBe('按决定执行。');
    const d2 = t2.details[0];
    if (d2.kind !== 'tool') throw new Error('not tool');
    expect(d2.state).toBe('fail');
    expect(d2.signal).toContain('SIGSEGV');
    // 定格
    expect(t1.status).toBe('complete');
    expect(t2.status).toBe('complete');
    expect(s.phase).toBe('idle');
    expect(s.streamingTurnId).toBeNull();
  });

  it('buildHistorySession：空/非法输入 → 空会话', () => {
    const s = buildHistorySession([]);
    expect(s.items).toHaveLength(0);
    expect(buildHistorySession(['x', 42, null]).items).toHaveLength(0);
  });

  it('buildHistorySession：纯空结论的 assistant 照发空块（不丢块）', () => {
    const s = buildHistorySession([
      { id: '1', role: 'user', content: 'q' },
      { id: '2', role: 'assistant', content: '' },
    ]);
    expect(s.items).toHaveLength(1);
    const t = s.items[0];
    expect(t.kind).toBe('turn');
    if (t.kind !== 'turn') throw new Error('not turn');
    expect(t.conclusion).toBe('');
    expect(t.status).toBe('complete');
  });
});

describe('autoRunRowsOf / mergeAutoRunRows（1.4.6 auto-run 历史合成行）', () => {
  it('run 记录 → ⚡ 合成行（无 loop 线丢弃）+ 合并去重', () => {
    const runRows = autoRunRowsOf([
      { id: 'run-1', name: 'cJSON 审计', envKey: 'pwn-vm', loopSessionId: 'ls-1', updatedAt: 1000 },
      { id: 'run-2', name: '无线的', envKey: 'fuzz', updatedAt: 2000 },
    ]);
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({ id: 'auto-run:run-1', title: '⚡ cJSON 审计', loopSessionId: 'ls-1', envKey: 'pwn-vm' });

    const base = [
      { id: 's1', title: '普通会话', createdAt: '', lastActiveAt: '', messageCount: 1, loopSessionId: 'ls-1' },
    ] as never[];
    const merged = mergeAutoRunRows(base, runRows);
    expect(merged).toHaveLength(1); // ls-1 已存在 → 不重复
    const merged2 = mergeAutoRunRows([], runRows);
    expect(merged2).toHaveLength(1);
  });
});

describe('applySessionTitleChange（1.4.7 SSE 漏面收口）', () => {
  const rows = [
    { id: 's1', title: '旧标题', createdAt: '', lastActiveAt: '', messageCount: 1 },
    { id: 's2', title: '另一个', createdAt: '', lastActiveAt: '', messageCount: 1 },
  ] as never[];

  it('命中行就地换标题；未命中/坏 payload 原样', () => {
    const next = applySessionTitleChange(rows, { sessionId: 's2', title: '新标题' });
    expect(next?.find((r) => r.id === 's2')?.title).toBe('新标题');
    expect(next?.find((r) => r.id === 's1')?.title).toBe('旧标题');
    expect(applySessionTitleChange(rows, { sessionId: 'ghost', title: 'x' })).toBe(rows);
    expect(applySessionTitleChange(null, { sessionId: 's1', title: 'x' })).toBeNull();
    expect(applySessionTitleChange(rows, { sessionId: 's1', title: '  ' })).toBe(rows);
  });
});
