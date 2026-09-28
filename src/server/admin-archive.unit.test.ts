/**
 * admin-archive handleArchiveOp 单测（1.8.4 桥接投影面）。
 *
 * 核心断言：handler 复用 research_archive 工具执行体——举证强度
 * （finding 必挂已存在 V# 证据）与纪律文本与 loop 内 agent 调用同口径；
 * 会话未锚定与非法 op 按业务错误返回（success=false），不 throw。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 锚定默认值的唯一来源——单测无引擎线，固定返回 '' 让「未锚定」分支确定可达
// （defaultEngine 在无会话时也可能给出非空 id，环境行为不定）。
vi.mock('./loop/chat-engine', () => ({ getPiSessionId: () => '' }));

import { handleArchiveOp } from './admin-archive';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'admin-archive-op-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleArchiveOp', () => {
  it('hypothesis → 成功并返回实体 id', async () => {
    const r = await handleArchiveOp(
      { sessionId: 'op-test-1', op: 'hypothesis', text: '目标存在 SQL 注入' },
      { dir },
    );
    expect(r.success).toBe(true);
    expect(String(r.data?.text)).toContain('H#1');
    expect(r.data?.entityId).toBe('H#1');
  });

  it('finding 零证据引用 → 举证强度拒绝（与 loop 工具同口径）', async () => {
    const r = await handleArchiveOp(
      { sessionId: 'op-test-2', op: 'finding', text: '存在注入' },
      { dir },
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('结论必须有证据支撑');
  });

  it('evidence 挂假设 → finding 挂证据，全链放行', async () => {
    await handleArchiveOp({ sessionId: 'op-test-3', op: 'hypothesis', text: 'H 假设' }, { dir });
    const ev = await handleArchiveOp(
      { sessionId: 'op-test-3', op: 'evidence', text: 'V 证据', refs: 'H#1' },
      { dir },
    );
    expect(ev.success).toBe(true);
    const fi = await handleArchiveOp(
      { sessionId: 'op-test-3', op: 'finding', text: 'C 结论', refs: 'V#1,H#1' },
      { dir },
    );
    expect(fi.success).toBe(true);
    expect(fi.data?.entityId).toBe('C#1');
  });

  it('未知 op → 业务错误（不 throw）', async () => {
    const r = await handleArchiveOp(
      { sessionId: 'op-test-4', op: 'nonsense', text: 'x' },
      { dir },
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未知操作');
  });

  it('会话未锚定（无当前线）→ 明确错误', async () => {
    // getPiSessionId 已被文件头 mock 为 ''——走未锚定分支
    const r = await handleArchiveOp({ op: 'hypothesis', text: 'x' }, { dir });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未锚定');
  });
});
