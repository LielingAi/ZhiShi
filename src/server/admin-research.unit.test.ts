/**
 * admin-research handler 单测（1.8.4 桥接投影面）。
 *
 * - handleClaimsRead：只读投影——会话 claims 文件原样返回；未锚定报错。
 * - handleResearchDistilled：空库不炸、返回摘要形状。
 * - handleDistillRun：参数校验 + 弧注入（不真烧 LLM）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 锚定默认值的唯一来源——单测无引擎线，固定返回 '' 让「未锚定」分支确定可达
vi.mock('./loop/chat-engine', () => ({ getPiSessionId: () => '' }));

import { handleClaimsRead, handleDistillRun, handleResearchDistilled } from './admin-research';
import { resetMemoryStoreForTest } from './memory/store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'admin-research-'));
});

afterEach(() => {
  // readResearchDistilled 打开的 memory.db 句柄有进程级缓存——先复位再删
  // 临时目录（Windows 句柄占用会让 rmSync EBUSY）。
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

function seedClaimsFile(sessionId: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.claims.json`), JSON.stringify({
    meta: { nextSeq: 2, updatedAt: '2026-09-28T00:00:00.000Z' },
    claims: [{
      id: 'S#1', kind: 'fact', text: '测试事实', status: 'active',
      lineStart: 1, lineEnd: 2, salience: 0.8,
      createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
      lastTouchedAt: '2026-09-28T00:00:00.000Z',
    }],
    audits: [],
  }, null, 2));
}

describe('handleClaimsRead', () => {
  it('返回会话 claims 与 audits', () => {
    seedClaimsFile('claims-test-1');
    const r = handleClaimsRead({ sessionId: 'claims-test-1' }, { dir });
    expect(r.success).toBe(true);
    const claims = r.data?.claims as Array<{ id: string; text: string }>;
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe('S#1');
    expect(claims[0].text).toBe('测试事实');
    expect(r.data?.nextSeq).toBe(2);
  });

  it('无文件会话 → 空投影（不炸）', () => {
    const r = handleClaimsRead({ sessionId: 'claims-test-empty' }, { dir });
    expect(r.success).toBe(true);
    expect(r.data?.claims).toEqual([]);
  });

  it('会话未锚定 → 明确错误', () => {
    const r = handleClaimsRead({}, { dir });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未锚定');
  });
});

describe('handleResearchDistilled', () => {
  it('空库返回摘要形状（不炸）', () => {
    const r = handleResearchDistilled({}, { baseDir: dir });
    expect(r.success).toBe(true);
    expect(r.data?.distilled).toBeTypeOf('object');
  });
});

describe('handleDistillRun', () => {
  it('非法 arc → 业务错误', async () => {
    const r = await handleDistillRun({ arc: 'nope', workspacePath: 'E:/x' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('非法 arc');
  });

  it('workspacePath 必填', async () => {
    const r = await handleDistillRun({ arc: 'cognitive' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('workspacePath');
  });

  it('arc=all 两条弧都跑并回传结果（注入假弧，不烧 LLM）', async () => {
    const calls: string[] = [];
    const r = await handleDistillRun({ arc: 'all', workspacePath: 'E:/x' }, {
      runCognitive: async () => { calls.push('cognitive'); return { status: 200, body: { success: true, outputText: 'c' } }; },
      runResearch: async () => { calls.push('research'); return { status: 200, body: { success: true, outputText: 'r' } }; },
    });
    expect(r.success).toBe(true);
    expect(calls).toEqual(['cognitive', 'research']);
    expect((r.data?.cognitive as { outputText: string }).outputText).toBe('c');
    expect((r.data?.research as { outputText: string }).outputText).toBe('r');
  });

  it('arc=cognitive 只跑认知弧；弧失败如实回报', async () => {
    const calls: string[] = [];
    const r = await handleDistillRun({ arc: 'cognitive', workspacePath: 'E:/x' }, {
      runCognitive: async () => { calls.push('cognitive'); return { status: 500, body: { success: false, error: 'boom' } }; },
      runResearch: async () => { calls.push('research'); return { status: 200, body: { success: true } }; },
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('认知弧失败');
    expect(calls).toEqual(['cognitive']);
  });
});
