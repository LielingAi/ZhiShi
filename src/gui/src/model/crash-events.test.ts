/**
 * 崩溃件检查器纯函数层单测（第四批 v4 落地）：fuzz 桶过滤 / createdAt
 * 倒序 / 两级匹配 / 标题缺省。
 */

import { describe, expect, it } from 'vitest';

import { crashEventTitle, evidencePayloadOf, EVIDENCE_TEXT_MAX, matchCrashClass, parseCrashEvents } from './crash-events';
import type { ResearchEventRow } from '../client/api';

function row(partial: Partial<ResearchEventRow>): ResearchEventRow {
  return partial;
}

describe('parseCrashEvents', () => {
  it('只留 taskKind===fuzz 的行——research/list 是混桶端点,triager 结论只落在 fuzz 桶', () => {
    const out = parseCrashEvents([
      row({ id: 1, taskKind: 'fuzz', bugClass: 'SIGSEGV-null-deref' }),
      row({ id: 2, taskKind: 'recon', bugClass: 'xss-reflected' }),
      row({ id: 3, taskKind: 'vuln-hunt', bugClass: 'sqli' }),
      row({ id: 4, bugClass: 'no-kind-dropped' }),
    ]);
    expect(out.map((e) => e.id)).toEqual([1]);
  });

  it('空行（既无 bugClass 又无 summary）丢弃——脏数据不进面板', () => {
    const out = parseCrashEvents([
      row({ id: 1, taskKind: 'fuzz', bugClass: 'A' }),
      row({ id: 2, taskKind: 'fuzz' }),
      row({ id: 3, taskKind: 'fuzz', summary: '' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('按 createdAt 倒序（最新在前——同信号 feed 语义）', () => {
    const out = parseCrashEvents([
      row({ id: 1, taskKind: 'fuzz', bugClass: 'A', createdAt: '2024-01-01T00:00:00Z' }),
      row({ id: 2, taskKind: 'fuzz', bugClass: 'B', createdAt: '2024-03-01T00:00:00Z' }),
      row({ id: 3, taskKind: 'fuzz', bugClass: 'C', createdAt: '2024-02-01T00:00:00Z' }),
    ]);
    expect(out.map((e) => e.id)).toEqual([2, 3, 1]);
  });

  it('createdAt 缺失排最后（不丢事件——triager 旧行可能无时间戳）', () => {
    const out = parseCrashEvents([
      row({ id: 1, taskKind: 'fuzz', bugClass: 'A', createdAt: '2024-01-01T00:00:00Z' }),
      row({ id: 2, taskKind: 'fuzz', bugClass: 'B' }),
    ]);
    expect(out.map((e) => e.id)).toEqual([1, 2]);
  });

  it('非数组输入返回空（端点形状不合不抛）', () => {
    expect(parseCrashEvents(undefined as unknown as ResearchEventRow[])).toEqual([]);
    expect(parseCrashEvents(null as unknown as ResearchEventRow[])).toEqual([]);
  });
});

describe('matchCrashClass', () => {
  const events = parseCrashEvents([
    row({ id: 1, taskKind: 'fuzz', bugClass: 'SIGSEGV-null-deref', createdAt: '2024-01-01T00:00:00Z' }),
    row({ id: 2, taskKind: 'fuzz', bugClass: 'heap-buffer-overflow-read', createdAt: '2024-01-02T00:00:00Z' }),
    row({ id: 3, taskKind: 'fuzz', bugClass: 'SIGSEGV-null-deref-write', createdAt: '2024-01-03T00:00:00Z' }),
  ]);

  it('第一级：bugClass 精确匹配优先', () => {
    const out = matchCrashClass(events, 'SIGSEGV-null-deref');
    expect(out.map((e) => e.id)).toEqual([1]);
  });

  it('第二级：无精确时 includes 模糊收拢同族指纹', () => {
    const out = matchCrashClass(events, 'SIGSEGV');
    expect(out.map((e) => e.id)).toEqual([3, 1]);
  });

  it('includes 命中不含精确项的另一半方向：chip 是长指纹、事件是短类', () => {
    const out = matchCrashClass(events, 'heap-buffer-overflow');
    expect(out.map((e) => e.id)).toEqual([2]);
  });

  it('无匹配返回 []——回落全量是调用方的决定,本函数不做隐式放宽', () => {
    expect(matchCrashClass(events, 'use-after-free')).toEqual([]);
  });

  it('fingerprint 为空白返回 []', () => {
    expect(matchCrashClass(events, '')).toEqual([]);
    expect(matchCrashClass(events, '   ')).toEqual([]);
  });
});

describe('crashEventTitle', () => {
  it('有 bugClass 用指纹作标题', () => {
    expect(crashEventTitle({ id: 1, bugClass: 'SIGSEGV-null-deref' })).toBe('SIGSEGV-null-deref');
  });

  it('缺 bugClass 回落 fuzz#id——单行标题不留空', () => {
    expect(crashEventTitle({ id: 42 })).toBe('fuzz#42');
  });

  it('id 也缺省（防御）回落 fuzz#?', () => {
    expect(crashEventTitle({ id: null })).toBe('fuzz#?');
  });
});

describe('evidencePayloadOf（1.9.20 挂证据到档案——archive/op evidence 入参）', () => {
  it('content = bugClass：summary 组合；anchor 带 fuzz 桶标注', () => {
    const p = evidencePayloadOf({
      id: 7,
      bugClass: 'segv-read-cJSON',
      summary: 'cJSON_Print 越界读，寄存器 rax=0x41414141',
      createdAt: '2026-10-16T08:30:00.000Z',
    });
    expect(p.op).toBe('evidence');
    expect(p.text).toBe('segv-read-cJSON：cJSON_Print 越界读，寄存器 rax=0x41414141');
    expect(p.anchor).toContain('crash-triager fuzz 桶');
    expect(p.anchor!.length).toBeGreaterThan('crash-triager fuzz 桶'.length); // 时间标注已挂上
  });

  it('无 summary → content 兜底 bugClass 单行', () => {
    expect(evidencePayloadOf({ id: 8, bugClass: 'heap-overflow-parse' }).text).toBe('heap-overflow-parse');
  });

  it('截断到 EVIDENCE_TEXT_MAX（照注入口径 200——实体无硬上限，注入单行截 200，超长无增量价值）', () => {
    const p = evidencePayloadOf({ id: 9, bugClass: 'bp', summary: 'x'.repeat(500) });
    expect(p.text.length).toBe(EVIDENCE_TEXT_MAX);
    expect(p.text.endsWith('…')).toBe(true);
  });

  it('指纹与结论双缺 → 空 text（store 侧挡下，不入库空证据）', () => {
    expect(evidencePayloadOf({ id: 10 }).text).toBe('');
  });
});
