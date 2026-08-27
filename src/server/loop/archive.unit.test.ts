/**
 * archive.unit.test.ts — 1.4.4 研究档案单测。
 *
 * 覆盖面：实体新增与编号、链接解析、纠正（append-only + 状态翻转 +
 * 级联待复核不连坐）、权威序（人纠正终局）、证伪/解决专门入口、
 * 持久化（锁内读写 + 损坏容错 + 跨实例读回）、注入/报告两种投影渲染、
 * 变更广播。全部走临时目录注入（dir 选项），零真实 IO。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addEvidence,
  addFinding,
  addHypothesis,
  addQuestion,
  ARCHIVE_CHANGED_EVENT,
  archiveFile,
  correctEntity,
  emptyArchive,
  falsifyHypothesis,
  loadArchive,
  parseEntityRefs,
  renderArchiveForInjection,
  renderArchiveForReport,
  resolveQuestion,
  type ArchiveSnapshot,
} from './archive';

let dir: string;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-archive-'));
  sessionId = `s-${Date.now().toString(36)}`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 建档助手：H1(栈溢出) + V1(崩溃证据) + C1(结论挂 V1) + Q1。 */
async function seedArchive(): Promise<ArchiveSnapshot> {
  await addQuestion(sessionId, { text: '远程入口输入限制是什么？' }, { dir });
  await addHypothesis(sessionId, { text: '输入长度无校验，可栈溢出', refs: 'Q#1' }, { dir });
  await addEvidence(sessionId, { text: 'SIGSEGV at 0x41414141，RIP 被覆盖', refs: 'H#1', anchorLabel: '第 2 轮 env_exec 输出' }, { dir });
  return addFinding(sessionId, { text: '栈溢出，可控制 RIP', findingType: 'primitive', refs: 'V#1' }, { dir });
}

describe('实体新增与编号', () => {
  it('四类实体按 H#/V#/C#/Q# 独立递增,初始状态正确', async () => {
    const q = await addQuestion(sessionId, { text: 'Q1 正文' }, { dir });
    expect(q.entities[0].id).toBe('Q#1');
    expect(q.entities[0].status).toBe('open');
    const h = await addHypothesis(sessionId, { text: 'H1 正文' }, { dir });
    expect(h.entities[1].id).toBe('H#1');
    expect(h.entities[1].status).toBe('pending');
    const v = await addEvidence(sessionId, { text: 'V1 正文' }, { dir });
    expect(v.entities[2].id).toBe('V#1');
    expect(v.entities[2].status).toBe('valid');
    const c = await addFinding(sessionId, { text: 'C1 正文', findingType: 'bug_class' }, { dir });
    expect(c.entities[3].id).toBe('C#1');
    expect(c.entities[3].status).toBe('established');
    expect(c.entities[3].findingType).toBe('bug_class');
  });

  it('来源锚与链接落盘（anchorMessageId/anchorLabel/refs）', async () => {
    const h = await addHypothesis(sessionId, { text: '假设', refs: 'Q#2,Q#1', anchorMessageId: '42', anchorLabel: '第 3 轮' }, { dir });
    const e = h.entities[0];
    expect(e.links).toEqual(['Q#2', 'Q#1']); // 保序去重
    expect(e.anchorMessageId).toBe('42');
    expect(e.anchorLabel).toBe('第 3 轮');
  });

  it('链接解析:非法 token 抛错,重复去重', () => {
    expect(parseEntityRefs('V#1,V#2,V#1')).toEqual(['V#1', 'V#2']);
    expect(parseEntityRefs(undefined)).toEqual([]);
    expect(() => parseEntityRefs('V#1,foo')).toThrow(/非法 id/);
  });
});

describe('纠正语义（append-only + 状态翻转 + 级联不连坐）', () => {
  it('纠正结论 → corrected + R#1 条目 + 原文不动', async () => {
    const seeded = await seedArchive();
    const out = await correctEntity(sessionId, { id: 'C#1', by: 'model', reason: '远程入口截断 64 字节，路径不可达' }, { dir });
    const c = out.entities.find((e) => e.id === 'C#1')!;
    expect(c.status).toBe('corrected');
    expect(c.text).toBe('栈溢出，可控制 RIP'); // 原文不动
    expect(out.corrections).toHaveLength(1);
    expect(out.corrections[0]).toMatchObject({ id: 'R#1', targetId: 'C#1', by: 'model' });
    expect(out.corrections[0].reason).toContain('截断');
    expect(seeded.entities.find((e) => e.id === 'C#1')!.status).toBe('established'); // 入参快照不受影响
  });

  it('级联:引用被纠正实体的下游打 needsReview,状态不翻(不连坐)', async () => {
    await seedArchive();
    // V1 被推翻 → C1 引用 V1 → C1 待复核但仍是 established。
    const out = await correctEntity(sessionId, { id: 'V#1', by: 'human', reason: 'gdb 读错,0x41414141 是 AAAA 不是 RIP' }, { dir });
    const v = out.entities.find((e) => e.id === 'V#1')!;
    const c = out.entities.find((e) => e.id === 'C#1')!;
    expect(v.status).toBe('overturned');
    expect(c.status).toBe('established');
    expect(c.needsReview).toBe(true);
    expect(c.reviewReason).toContain('V#1');
  });

  it('权威序:人纠正后的实体,模型再纠正被拒', async () => {
    await seedArchive();
    await correctEntity(sessionId, { id: 'C#1', by: 'human', reason: '人已终审' }, { dir });
    await expect(
      correctEntity(sessionId, { id: 'C#1', by: 'model', reason: '模型想翻案' }, { dir }),
    ).rejects.toThrow(/人纠正/);
  });

  it('纠正不存在的实体抛错;纠正必须带 reason', async () => {
    await expect(correctEntity(sessionId, { id: 'H#99', by: 'human', reason: 'x' }, { dir })).rejects.toThrow(/不存在/);
    await expect(correctEntity(sessionId, { id: 'H#1', by: 'human', reason: '  ' }, { dir })).rejects.toThrow(/reason/);
  });
});

describe('证伪与解决专门入口', () => {
  it('falsifyHypothesis = by:model 的纠正别名(假设 → falsified)', async () => {
    const h = await addHypothesis(sessionId, { text: '假设一' }, { dir });
    const out = await falsifyHypothesis(sessionId, 'H#1', '本地成立但远程不可达', { dir });
    expect(out.entities.find((e) => e.id === 'H#1')!.status).toBe('falsified');
    expect(out.corrections[0]).toMatchObject({ by: 'model', targetId: 'H#1' });
  });

  it('resolveQuestion:open → resolved,note 挂进 links', async () => {
    await addQuestion(sessionId, { text: '还缺哪一环？' }, { dir });
    const out = await resolveQuestion(sessionId, { id: 'Q#1', note: '已由 C#1 回答' }, { dir });
    expect(out.entities[0].status).toBe('resolved');
    expect(out.entities[0].links).toContain('note:已由 C#1 回答');
  });

  it('resolveQuestion 对非问题实体抛错', async () => {
    await addHypothesis(sessionId, { text: 'H' }, { dir });
    await expect(resolveQuestion(sessionId, { id: 'H#1' }, { dir })).rejects.toThrow(/未决问题/);
  });
});

describe('持久化（锁内读写 + 容错）', () => {
  it('写后读回:实体/纠正/编号全量还原,编号跨写递增', async () => {
    await seedArchive();
    await correctEntity(sessionId, { id: 'C#1', by: 'model', reason: 'r' }, { dir });
    const loaded = loadArchive(sessionId, { dir });
    expect(loaded.entities.map((e) => e.id)).toEqual(['Q#1', 'H#1', 'V#1', 'C#1']);
    expect(loaded.corrections.map((c) => c.id)).toEqual(['R#1']);
    expect(loaded.updatedAt).not.toBe('');
    // 编号续接:再写一个实体是 H#2 不是 H#1。
    const again = await addHypothesis(sessionId, { text: '第二个假设' }, { dir });
    expect(again.entities.filter((e) => e.kind === 'hypothesis').map((e) => e.id)).toEqual(['H#1', 'H#2']);
  });

  it('缺失文件 → 空档案;损坏文件 → 空档案(读侧容错不炸)', () => {
    expect(loadArchive('ghost', { dir }).entities).toEqual([]);
    writeFileSync(archiveFile(sessionId, dir), '{broken json', 'utf-8');
    expect(loadArchive(sessionId, { dir }).entities).toEqual([]);
  });

  it('文件内容为 JSON 全量(与 loop-sessions jsonl 互不干扰)', async () => {
    await seedArchive();
    const raw = readFileSync(archiveFile(sessionId, dir), 'utf-8');
    expect(JSON.parse(raw).entities).toHaveLength(4);
  });

  it('emptyArchive 形状(零注入依赖)', () => {
    expect(emptyArchive('x')).toEqual({ sessionId: 'x', entities: [], corrections: [], updatedAt: '' });
  });
});

describe('投影 — 注入段', () => {
  it('空档案零注入', () => {
    expect(renderArchiveForInjection(undefined)).toBe('');
    expect(renderArchiveForInjection(emptyArchive('x'))).toBe('');
  });

  it('分组呈现:待答问题/当前假设/最新证据/已确立结论/待复核', async () => {
    const snap = await seedArchive();
    const out = renderArchiveForInjection(snap);
    expect(out).toContain('<zhishi-research-archive>');
    expect(out).toContain('待答问题');
    expect(out).toContain('当前假设');
    expect(out).toContain('最新证据');
    expect(out).toContain('已确立结论');
    expect(out).toContain('Q#1');
    expect(out).toContain('（V#1）'); // 结论的证据锚
  });

  it('超预算硬顶截断并带标记', async () => {
    await seedArchive();
    const long = 'x'.repeat(110);
    for (let i = 0; i < 8; i++) await addQuestion(sessionId, { text: `问题 ${i} ${long}` }, { dir });
    for (let i = 0; i < 8; i++) await addHypothesis(sessionId, { text: `假设 ${i} ${long}` }, { dir });
    for (let i = 0; i < 8; i++) await addFinding(sessionId, { text: `结论 ${i} ${long}` }, { dir });
    const out = renderArchiveForInjection(loadArchive(sessionId, { dir }), 800);
    expect(out.length).toBeLessThanOrEqual(800);
    expect(out).toContain('已截断');
    expect(out.endsWith('</zhishi-research-archive>')).toBe(true); // 收尾标签保底
  });

  it('待复核实体进待复核组', async () => {
    await seedArchive();
    await correctEntity(sessionId, { id: 'V#1', by: 'model', reason: '读错' }, { dir });
    const out = renderArchiveForInjection(loadArchive(sessionId, { dir }));
    expect(out).toContain('待复核');
    expect(out).toContain('C#1');
  });
});

describe('投影 — 报告', () => {
  it('空档案 → 空(报告不出现空章节)', () => {
    expect(renderArchiveForReport(undefined)).toBe('');
  });

  it('结论带证据锚;证伪与纠正独立章节;未决问题章节', async () => {
    await seedArchive();
    await correctEntity(sessionId, { id: 'C#1', by: 'model', reason: '远程不可达' }, { dir });
    const out = renderArchiveForReport(loadArchive(sessionId, { dir }));
    expect(out).toContain('## 研究结论');
    expect(out).toContain('—— 证据：V#1');
    expect(out).toContain('（已纠正）');
    expect(out).toContain('## 证伪与纠正');
    expect(out).toContain('模型自证伪');
    expect(out).toContain('## 未决问题');
    expect(out).toContain('## 证据清单');
  });
});

describe('变更广播', () => {
  it('每次写操作广播 archive:changed(带 sessionId 与全量实体)', async () => {
    const fn = vi.fn();
    await addHypothesis(sessionId, { text: 'H' }, { dir, broadcastFn: fn });
    expect(fn).toHaveBeenCalledTimes(1);
    const [event, data] = fn.mock.calls[0] as [string, { sessionId: string; entities: unknown[] }];
    expect(event).toBe(ARCHIVE_CHANGED_EVENT);
    expect(data.sessionId).toBe(sessionId);
    expect(data.entities).toHaveLength(1);
    // 不传 broadcastFn 不炸(no-op)。
    await addEvidence(sessionId, { text: 'V' }, { dir });
  });
});
