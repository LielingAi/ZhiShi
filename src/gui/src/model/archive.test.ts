/**
 * archive.test.ts — 1.4.4 研究档案 GUI 模型层单测。
 *
 * 覆盖面：archive:changed payload 归一化（读侧容错）、分组选择器
 * （待答问题/当前假设/结论/证据/证伪）、徽章计数、引用过滤。
 */

import { describe, expect, it } from 'vitest';

import {
  applyArchiveChanged,
  archiveBadgeCount,
  archiveConfirmedHypotheses,
  archiveEvidence,
  archiveFalsified,
  archiveFindings,
  archiveOpenQuestions,
  archiveOrphans,
  archivePendingHypotheses,
  archiveThreads,
  entityRefs,
  findingEvidenceCounts,
  type ArchiveSnapshot,
} from './archive';

function snap(): ArchiveSnapshot {
  return {
    sessionId: 's-1',
    updatedAt: 't',
    entities: [
      { id: 'Q#1', kind: 'question', text: '远程入口限制？', status: 'open', links: [], createdAt: 't', updatedAt: 't' },
      { id: 'H#1', kind: 'hypothesis', text: '长度无校验', status: 'falsified', links: ['Q#1'], createdAt: 't', updatedAt: 't' },
      { id: 'H#2', kind: 'hypothesis', text: '解析器二次拷贝', status: 'pending', links: [], createdAt: 't', updatedAt: 't' },
      { id: 'H#3', kind: 'hypothesis', text: '扩展段多写一字节', status: 'confirmed', links: ['V#1'], createdAt: 't', updatedAt: 't' },
      { id: 'V#1', kind: 'evidence', text: 'SIGSEGV 崩溃', status: 'valid', links: ['H#1'], anchorMessageId: '42', createdAt: 't', updatedAt: 't' },
      { id: 'C#1', kind: 'finding', text: '栈溢出可控制 RIP', status: 'corrected', links: ['V#1'], findingType: 'primitive', needsReview: true, reviewReason: '依赖被纠正（V#1：gdb 读错）', createdAt: 't', updatedAt: 't' },
    ],
    corrections: [{ id: 'R#1', targetId: 'H#1', by: 'model', reason: '本地成立远程不可达', createdAt: 't' }],
  };
}

describe('applyArchiveChanged（payload 归一化）', () => {
  it('合法 payload → 完整快照（实体/纠正/字段透传）', () => {
    const s = applyArchiveChanged(snap());
    expect(s.sessionId).toBe('s-1');
    expect(s.entities).toHaveLength(6);
    expect(s.entities[4]).toMatchObject({ id: 'V#1', anchorMessageId: '42', links: ['H#1'] });
    expect(s.corrections[0]).toMatchObject({ id: 'R#1', by: 'model' });
  });

  it('脏 payload → 读侧容错（坏实体丢弃、字段缺省、不炸）', () => {
    const s = applyArchiveChanged({
      sessionId: 'x',
      entities: [
        { id: 'V#1', text: 'ok', kind: 'evidence', status: 'valid', links: 'not-array' },
        { id: 'bad', kind: 'evidence' }, // 缺 text → 丢
        42, // 非对象 → 丢
        null,
      ],
      corrections: [{ id: 'R#1' }, { targetId: 'only-target' }],
    });
    expect(s.entities).toHaveLength(1);
    expect(s.entities[0].links).toEqual([]);
    expect(s.corrections).toHaveLength(0);
    expect(applyArchiveChanged(undefined).entities).toEqual([]);
    expect(applyArchiveChanged(null).entities).toEqual([]);
  });
});

describe('分组选择器', () => {
  it('待答问题/当前假设/结论/证据/证伪分区正确', () => {
    const s = snap();
    expect(archiveOpenQuestions(s).map((e) => e.id)).toEqual(['Q#1']);
    expect(archivePendingHypotheses(s).map((e) => e.id)).toEqual(['H#2']);
    expect(archiveConfirmedHypotheses(s).map((e) => e.id)).toEqual(['H#3']);
    expect(archiveFindings(s).map((e) => e.id)).toEqual(['C#1']);
    expect(archiveEvidence(s).map((e) => e.id)).toEqual(['V#1']);
    // 证伪与纠正区：R#1 纠正条目挂 H#1（已证伪的假设,带纠正记录不再重复行）。
    const f = archiveFalsified(s);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ correction: { id: 'R#1' }, entity: { id: 'H#1' } });
  });

  it('null 档案 → 全空（面板空态依赖）', () => {
    expect(archiveOpenQuestions(null)).toEqual([]);
    expect(archiveFalsified(null)).toEqual([]);
    expect(archiveBadgeCount(null)).toBe(0);
  });

  it('徽章计数 = 未决问题 + 待复核', () => {
    expect(archiveBadgeCount(snap())).toBe(2); // Q#1 + C#1(needsReview)
  });

  it('entityRefs 只保留 H#/V#/C#/Q# 形态（note: 等过滤掉）', () => {
    expect(entityRefs({ id: 'C#1', kind: 'finding', text: '', status: 'x', links: ['V#1', 'H#2', 'note:xxx', 'junk'], createdAt: 't', updatedAt: 't' })).toEqual(['V#1', 'H#2']);
  });
});

describe('1.4.8 链式投影（研究线派生 + 孤儿区 + 反证计数）', () => {
  function chainSnap(): ArchiveSnapshot {
    return {
      sessionId: 's-1',
      updatedAt: 't',
      entities: [
        { id: 'H#1', kind: 'hypothesis', text: '长度无校验', status: 'pending', links: [], createdAt: 't', updatedAt: 't' },
        { id: 'V#1', kind: 'evidence', text: '崩溃复现', status: 'valid', links: ['H#1'], createdAt: 't', updatedAt: 't' },
        { id: 'V#2', kind: 'evidence', text: '远程未复现（反证）', status: 'valid', links: ['H#1'], createdAt: 't', updatedAt: 't' },
        { id: 'C#1', kind: 'finding', text: '栈溢出可控 RIP', status: 'established', links: ['V#1'], against: ['V#2'], createdAt: 't', updatedAt: 't' },
        { id: 'H#2', kind: 'hypothesis', text: '空线假设', status: 'falsified', links: [], createdAt: 't', updatedAt: 't' },
        { id: 'V#3', kind: 'evidence', text: '顺手观察', status: 'valid', links: [], createdAt: 't', updatedAt: 't' },
        { id: 'C#2', kind: 'finding', text: '断链结论', status: 'established', links: ['V#3'], createdAt: 't', updatedAt: 't' },
      ],
      corrections: [],
    };
  }

  it('链组装：证据挂假设归线，结论经链上 V# 反推归线', () => {
    const threads = archiveThreads(chainSnap());
    expect(threads.map((t) => t.hypothesis.id)).toEqual(['H#1', 'H#2']);
    expect(threads[0].evidence.map((e) => e.id)).toEqual(['V#1', 'V#2']);
    expect(threads[0].findings.map((e) => e.id)).toEqual(['C#1']); // 经 V#1 反推
    expect(threads[1].evidence).toEqual([]);
    expect(threads[1].findings).toEqual([]);
  });

  it('孤儿区：未挂假设的证据 + 不挂研究线的结论（断链显式化）', () => {
    const orphans = archiveOrphans(chainSnap());
    expect(orphans.evidence.map((e) => e.id)).toEqual(['V#3']);
    expect(orphans.findings.map((e) => e.id)).toEqual(['C#2']); // 只挂孤儿 V#3，归不了线
  });

  it('against 归一化（读侧容错）+ findingEvidenceCounts 支持/反证计数', () => {
    const s = applyArchiveChanged(chainSnap());
    const c1 = s.entities.find((e) => e.id === 'C#1')!;
    expect(c1.against).toEqual(['V#2']);
    expect(findingEvidenceCounts(c1)).toEqual({ supports: 1, against: 1 });
  });

  it('null/空档案 → 空链空孤儿（面板空态依赖）', () => {
    expect(archiveThreads(null)).toEqual([]);
    expect(archiveOrphans(null)).toEqual({ evidence: [], findings: [] });
  });
});
