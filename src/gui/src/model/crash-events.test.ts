/**
 * 崩溃件检查器纯函数层单测（第四批 v4 落地）：fuzz 桶过滤 / createdAt
 * 倒序 / 两级匹配 / 标题缺省。
 */

import { describe, expect, it } from 'vitest';

import { crashEventTitle, matchCrashClass, parseCrashEvents } from './crash-events';
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
