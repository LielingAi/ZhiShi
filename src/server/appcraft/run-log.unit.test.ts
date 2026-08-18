// Unit tests for the AppCraft run log (作品架账本, COWORK_logic 任务5).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregateAppcraftRunStats, appendAppcraftRun } from './run-log';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'appcraft-runlog-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('appendAppcraftRun', () => {
  it('appends one JSONL line under .appcraft/runs.jsonl', () => {
    const writes: Array<{ path: string; line: string }> = [];
    appendAppcraftRun(ws, {
      ts: '2026-07-31T10:00:00Z', id: 'monthly-report', kind: 'skill',
      success: true, executedSteps: 5, stepCount: 5,
    }, (path, line) => writes.push({ path, line }));
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(join(ws, '.appcraft', 'runs.jsonl'));
    expect(JSON.parse(writes[0].line)).toMatchObject({ id: 'monthly-report', success: true });
  });

  it('is best-effort: writer failure never throws', () => {
    expect(() =>
      appendAppcraftRun(ws, {
        ts: 'x', id: 'a', kind: 'skill', success: false, executedSteps: 0, stepCount: 3,
      }, () => { throw new Error('disk full'); }),
    ).not.toThrow();
  });
});

describe('aggregateAppcraftRunStats', () => {
  it('returns empty map when no logs exist', () => {
    expect(aggregateAppcraftRunStats(ws).size).toBe(0);
  });

  it('aggregates run counts, success counts, and latest timestamps', () => {
    const dir = join(ws, '.appcraft');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runs.jsonl'), [
      JSON.stringify({ ts: '2026-07-01T00:00:00Z', id: 'a', kind: 'skill', success: true, executedSteps: 3, stepCount: 3 }),
      JSON.stringify({ ts: '2026-07-02T00:00:00Z', id: 'a', kind: 'skill', success: false, executedSteps: 1, stepCount: 3, failedStep: 1 }),
      JSON.stringify({ ts: '2026-07-03T00:00:00Z', id: 'b', kind: 'recording', success: true, executedSteps: 2, stepCount: 2 }),
      'not-json',
    ].join('\n'), 'utf-8');
    writeFileSync(join(dir, 'sop-heals.jsonl'), [
      JSON.stringify({ ts: '2026-07-02T01:00:00Z', sessionId: 's1', skill: 'a', event: 'sop_continuation_started' }),
    ].join('\n'), 'utf-8');

    const stats = aggregateAppcraftRunStats(ws);
    const a = stats.get('a');
    expect(a).toMatchObject({ totalRuns: 2, okRuns: 1, lastRunAt: '2026-07-02T00:00:00Z', heals: 1, lastHealAt: '2026-07-02T01:00:00Z' });
    const b = stats.get('b');
    expect(b).toMatchObject({ totalRuns: 1, okRuns: 1, heals: 0 });
  });
});
