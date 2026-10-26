import { describe, expect, it } from 'vitest';

import type { ArchiveEntity, ArchiveSnapshot } from './archive';
import { buildArchiveBrief } from './archive-brief';

function entity(partial: Partial<ArchiveEntity> & Pick<ArchiveEntity, 'id' | 'kind' | 'status' | 'text'>): ArchiveEntity {
  return {
    links: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function snapshot(): ArchiveSnapshot {
  return {
    sessionId: 's',
    updatedAt: '',
    corrections: [
      { id: 'R#1', targetId: 'C#4', by: 'human', reason: '复现失败，是测试脚本写错了', createdAt: '' },
      { id: 'R#2', targetId: 'H#1', by: 'model', reason: '输入已规范化，路径穿越不可达', createdAt: '' },
    ],
    entities: [
      entity({ id: 'V#1', kind: 'evidence', status: 'valid', text: 'sqlmap 回显会话' }),
      entity({ id: 'V#2', kind: 'evidence', status: 'doubtful', text: '只见过一次 500' }),
      entity({ id: 'V#3', kind: 'evidence', status: 'valid', text: 'WAF 返回 403' }),
      entity({ id: 'C#1', kind: 'finding', status: 'established', text: '登录口 SQL 注入可读会话', links: ['V#1'] }),
      entity({ id: 'C#2', kind: 'finding', status: 'established', text: '文件读取（证据存疑）', links: ['V#2'] }),
      entity({ id: 'C#3', kind: 'finding', status: 'established', text: '后台 SQL 注入（有反证）', links: ['V#1'], against: ['V#3'] }),
      entity({ id: 'C#4', kind: 'finding', status: 'corrected', text: '误报的 RCE', links: ['V#1'] }),
      entity({ id: 'Q#1', kind: 'question', status: 'open', text: 'WAF 怎么绕？' }),
      entity({ id: 'H#1', kind: 'hypothesis', status: 'falsified', text: '可能有路径穿越' }),
    ],
  };
}

describe('buildArchiveBrief', () => {
  it('靠得住：established + 有效证据 + 无反证 + 非待复核', () => {
    const brief = buildArchiveBrief(snapshot());
    expect(brief.solid.map((x) => x.id)).toEqual(['C#1']);
    expect(brief.solid[0]).toMatchObject({ support: 1, against: 0 });
  });

  it('还缺什么：问题优先，其次证据不足/反证待评估', () => {
    const brief = buildArchiveBrief(snapshot());
    const ids = brief.gaps.map((x) => x.id);
    expect(ids[0]).toBe('Q#1');
    expect(ids).toContain('C#2');
    expect(ids).toContain('C#3');
    const c2 = brief.gaps.find((x) => x.id === 'C#2')!;
    expect(c2.reason).toContain('没有有效支持证据');
    const c3 = brief.gaps.find((x) => x.id === 'C#3')!;
    expect(c3.reason).toContain('反证');
  });

  it('已排除：带原因（取最近一条 correction），解释为什么放弃', () => {
    const brief = buildArchiveBrief(snapshot());
    const ids = brief.closed.map((x) => x.id);
    expect(ids).toEqual(['C#4', 'H#1']);
    expect(brief.closed.find((x) => x.id === 'C#4')!.reason).toContain('测试脚本写错');
    expect(brief.closed.find((x) => x.id === 'H#1')!.reason).toContain('不可达');
  });

  it('同一实体不会同时出现在两个分区', () => {
    const brief = buildArchiveBrief(snapshot());
    const all = [...brief.solid, ...brief.gaps, ...brief.closed].map((x) => x.id);
    expect(new Set(all).size).toBe(all.length);
  });
});
