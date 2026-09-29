// trust 账本单测（1.8.7 P2 署名面）：actorName additive——
// 带署名落库读回 / 不带署名缺省（旧行为）/ 存量 NULL 事件兼容。
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTrustLedger, recordTrustTransition } from './trust';
import { resetMemoryStoreForTest } from './store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-trust-'));
  resetMemoryStoreForTest();
});

afterEach(() => {
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('trust_events：actorName 署名（1.8.7 P2 additive）', () => {
  it('actorName 落库并读回；agent/user 二分字段不动', () => {
    const recorded = recordTrustTransition(
      { taskId: 't1', taskName: '任务一', from: 'running', to: 'done', actor: 'agent', actorName: 'alice' },
      dir,
    );
    expect(recorded).toBe(true);
    const ledger = readTrustLedger(50, dir);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toMatchObject({ taskId: 't1', kind: 'deposit', reason: 'agent_done', actorName: 'alice' });
  });

  it('不带 actorName → 字段缺省（旧行为/存量事件兼容）', () => {
    recordTrustTransition({ taskId: 't2', taskName: '任务二', from: 'running', to: 'done', actor: 'user' }, dir);
    const ledger = readTrustLedger(50, dir);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].reason).toBe('user_done');
    expect('actorName' in ledger.events[0]).toBe(false);
  });
});
