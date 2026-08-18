// 安全经验 memory kinds 单测（安全研究员版 P1 D2，技术方案 §1.4）：
// research-log / vuln-pattern / tool-combo 三类——可写可读、cap 挤兑、衰减分档。
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  effectiveScore,
  listActive,
  listArchive,
  MEMORY_KINDS,
  putEntry,
  resetMemoryStoreForTest,
} from './store';

let dir: string;
const NOW = Date.parse('2026-08-14T12:00:00Z');
const DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-seckinds-'));
  resetMemoryStoreForTest();
});

afterEach(() => {
  // SQLite（WAL）持有文件锁——先关句柄再删目录，否则 Windows EBUSY。
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('D2：安全 memory kinds 定义', () => {
  it('MemoryKind 穷举含四类认知 kind + 三类安全 kind', () => {
    expect([...MEMORY_KINDS]).toEqual([
      'user-model', 'self-model', 'routines', 'reminder',
      'research-log', 'vuln-pattern', 'tool-combo',
    ]);
  });
});

describe('D2：三类可写可读', () => {
  it('research-log / vuln-pattern / tool-combo 写入后按 kind 读回', () => {
    putEntry({ kind: 'research-log', content: 'hacknote：fastbin dup 拿 flag', salience: 0.5 }, dir, NOW);
    putEntry({ kind: 'vuln-pattern', content: 'glibc 2.31 tcache 无 count 检查，dup 直接打', salience: 0.8 }, dir, NOW);
    putEntry({ kind: 'tool-combo', content: 'pwndbg + ROPgadget 够打 ret2libc；angr 对大二进制太慢', salience: 0.7 }, dir, NOW);

    expect(listActive('research-log', dir, NOW).map((e) => e.content)).toEqual(['hacknote：fastbin dup 拿 flag']);
    expect(listActive('vuln-pattern', dir, NOW)[0].content).toContain('tcache');
    expect(listActive('tool-combo', dir, NOW)[0].content).toContain('ROPgadget');
  });
});

describe('D2：cap 挤兑（残差守恒——被挤掉的进 archive）', () => {
  it('vuln-pattern cap 20：第 21 条挤掉有效分最低者', () => {
    for (let i = 0; i < 21; i++) {
      // 三位零填充序号：两两 dice 相似度 0.8 < 合并阈值 0.82，不会被近似去重合并。
      putEntry({ kind: 'vuln-pattern', content: `vp-${String(i).padStart(3, '0')}`, salience: i / 100 }, dir, NOW + i);
    }
    const active = listActive('vuln-pattern', dir, NOW + 100);
    expect(active).toHaveLength(20);
    // salience 最低的 vp-000 被挤进 archive。
    expect(active.some((e) => e.content === 'vp-000')).toBe(false);
    expect(listArchive(dir).some((e) => e.content === 'vp-000' && e.kind === 'vuln-pattern')).toBe(true);
  });

  it('tool-combo cap 20：第 21 条挤掉最低分', () => {
    for (let i = 0; i < 21; i++) {
      putEntry({ kind: 'tool-combo', content: `tc-${String(i).padStart(3, '0')}`, salience: i / 100 }, dir, NOW + i);
    }
    expect(listActive('tool-combo', dir, NOW + 100)).toHaveLength(20);
    expect(listArchive(dir).some((e) => e.content === 'tc-000' && e.kind === 'tool-combo')).toBe(true);
  });

  it('research-log cap 60：第 61 条挤掉最低分', () => {
    for (let i = 0; i < 61; i++) {
      putEntry({ kind: 'research-log', content: `rl-${String(i).padStart(3, '0')}`, salience: i / 100 }, dir, NOW + i);
    }
    expect(listActive('research-log', dir, NOW + 100)).toHaveLength(60);
    expect(listArchive(dir).some((e) => e.content === 'rl-000' && e.kind === 'research-log')).toBe(true);
  });
});

describe('D2：衰减分档（recencyDecay 半衰期按 kind）', () => {
  it('research-log 14 天 / vuln-pattern 90 天 / tool-combo 60 天', () => {
    putEntry({ kind: 'research-log', content: 'rl', salience: 0.8 }, dir, NOW - 14 * DAY);
    putEntry({ kind: 'vuln-pattern', content: 'vp', salience: 0.8 }, dir, NOW - 90 * DAY);
    putEntry({ kind: 'tool-combo', content: 'tc', salience: 0.8 }, dir, NOW - 60 * DAY);

    // 半衰期整倍数处 decay = 0.5：有效分 = salience × 0.5 × usefulness(1.0)。
    expect(effectiveScore(listActive('research-log', dir, NOW)[0], NOW)).toBeCloseTo(0.4, 5);
    expect(effectiveScore(listActive('vuln-pattern', dir, NOW)[0], NOW)).toBeCloseTo(0.4, 5);
    expect(effectiveScore(listActive('tool-combo', dir, NOW)[0], NOW)).toBeCloseTo(0.4, 5);
  });

  it('安全 kind 之间衰减速度不同：同龄 30 天，research-log 已过半衰期，vuln-pattern 还年轻', () => {
    putEntry({ kind: 'research-log', content: 'rl', salience: 0.8 }, dir, NOW - 30 * DAY);
    putEntry({ kind: 'vuln-pattern', content: 'vp', salience: 0.8 }, dir, NOW - 30 * DAY);
    const rl = effectiveScore(listActive('research-log', dir, NOW)[0], NOW);
    const vp = effectiveScore(listActive('vuln-pattern', dir, NOW)[0], NOW);
    expect(rl).toBeLessThan(0.8 * 0.5);
    expect(vp).toBeGreaterThan(0.8 * 0.7);
  });
});
