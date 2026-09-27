// gap_events 单测（WORK_LOOP §5 能力雷达）：记录 → 归一化合并 → 复发计数。
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listGapRecurrences,
  logGapEvent,
  resetMemoryStoreForTest,
} from './store';

let dir: string;
const NOW = Date.parse('2026-08-05T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-gaps-'));
  resetMemoryStoreForTest();
});

afterEach(() => {
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('gap_events：logGapEvent / listGapRecurrences', () => {
  it('记录并按 gap_key 聚合计数（同义归一化合并）', () => {
    logGapEvent({ gapKey: 'unknown-skill:foo' }, dir, NOW - 1000);
    logGapEvent({ gapKey: 'Unknown-Skill:FOO' }, dir, NOW - 500); // 大小写差异应合并
    logGapEvent({ gapKey: 'unknown-skill:bar' }, dir, NOW);

    const rows = listGapRecurrences({ baseDir: dir, now: NOW });
    expect(rows).toHaveLength(2);
    expect(rows[0].gapKey).toBe('unknown-skill:foo');
    expect(rows[0].count).toBe(2);
    expect(rows[1].gapKey).toBe('unknown-skill:bar');
    expect(rows[1].count).toBe(1);
  });

  it('minCount 过滤 + 窗口外不计 + 最新细节随行', () => {
    logGapEvent({ gapKey: 'tool-not-found:a', detail: '第一次' }, dir, NOW - 8 * 24 * 3600_000); // 出 7 天窗
    logGapEvent({ gapKey: 'tool-not-found:b', detail: '旧细节' }, dir, NOW - 2000);
    logGapEvent({ gapKey: 'tool-not-found:b', detail: '新细节' }, dir, NOW - 1000);
    logGapEvent({ gapKey: 'tool-not-found:c' }, dir, NOW);

    const recurring = listGapRecurrences({ baseDir: dir, now: NOW, minCount: 2 });
    expect(recurring).toHaveLength(1);
    expect(recurring[0].gapKey).toBe('tool-not-found:b');
    expect(recurring[0].latestDetail).toBe('新细节');

    const all = listGapRecurrences({ baseDir: dir, now: NOW, minCount: 1 });
    expect(all.map((r) => r.gapKey).sort()).toEqual(['tool-not-found:b', 'tool-not-found:c']);
  });

  it('空 gapKey 不落库；缺省字段为 null', () => {
    logGapEvent({ gapKey: '   ' }, dir, NOW);
    logGapEvent({ gapKey: 'unknown-tool:x' }, dir, NOW);

    const rows = listGapRecurrences({ baseDir: dir, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].latestDetail).toBeNull();
  });
});
