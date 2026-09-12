/**
 * 1.7.2 — claim-governance.ts 单测（fake 提取器,不触真实模型）。
 *
 * 覆盖：空窗口 / 提取成功三路落库 + 游标推进 + 审计 / 提取失败不推进 /
 * 去重 / 冲突收敛 superseded / 衰减归档 / 准入纯校验 / JSON 提取容错。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  admitExtraction,
  parseExtractionJson,
  runClaimGovernance,
  type Extractor,
} from './claim-governance';
import { appendLoopMessages, loadLoopSession } from './session';
import { loadArchive } from './archive';
import { loadSessionClaims } from './session-claims';
import { resetMemoryStoreForTest } from '../memory/store';

let dir: string;
let prevDataDir: string | undefined;

function msg(role: AgentMessage['role'], text: string, n: number): AgentMessage {
  return { role, content: text, timestamp: n } as AgentMessage;
}

function makeSession(id: string, messages: AgentMessage[]): Promise<void> {
  return appendLoopMessages(id, messages, { model: 'deepseek-v4-pro', providerId: 'deepseek' }, { dir });
}

const FAKE_OK: Extractor = async () => ({
  ok: true,
  output: {
    archiveEntities: [
      { kind: 'hypothesis', text: '偏移 72 处发生溢出', refs: ['H#1'] },
      { kind: 'evidence', text: 'cyclic 反查偏移 72', refs: ['H#1'] },
    ],
    researchEvents: [{ taskKind: 'binary', outcome: 'success', summary: 'ret2win 打通拿 flag' }],
    claims: [
      { kind: 'fact', text: '目标 PIE 关闭', subject: '二进制防护', searchTerms: ['PIE', '防护'], salience: 0.8 },
      { kind: 'dead-end', text: 'gdb 布局与真机不一致', subject: '调试', searchTerms: ['gdb'], salience: 0.4 },
    ],
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-governance-'));
  prevDataDir = process.env.ZHISHI_DATA_DIR;
  process.env.ZHISHI_DATA_DIR = dir;
  resetMemoryStoreForTest();
});

afterEach(() => {
  resetMemoryStoreForTest(); // 释放 sqlite 连接——Windows 下文件锁否则 EBUSY
  if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('runClaimGovernance（fake 提取器）', () => {
  it('空窗口（游标已到尾部）→ ok 且不动', async () => {
    await makeSession('s1', [msg('user', 'hi', 1)]);
    await runClaimGovernance('s1', { extract: FAKE_OK, dir, workspace: '/ws' });
    const r = await runClaimGovernance('s1', { extract: FAKE_OK, dir, workspace: '/ws' });
    expect(r.ok).toBe(true);
    expect(r.cursorFrom).toBe(r.cursorTo);
  });

  it('提取成功 → 三路落库 + 游标推进 + 审计', async () => {
    await makeSession('s1', [
      msg('user', '分析目标', 1),
      msg('assistant', '分析中', 2),
      msg('toolResult', 'exit=0 结论', 3),
    ]);
    const r = await runClaimGovernance('s1', { extract: FAKE_OK, dir, workspace: '/ws' });
    expect(r.ok).toBe(true);
    expect(r.cursorTo).toBe(3);
    expect(r.admitted).toBe(5);
    // claims 文件
    const claims = loadSessionClaims('s1', { dir });
    expect(claims.claims.filter((c) => c.status === 'active')).toHaveLength(2);
    expect(claims.claims[0].id).toBe('S#1');
    expect(claims.claims[0].lineStart).toBe(2); // 游标 0 + 行 2
    expect(claims.claims[0].searchTerms).toContain('PIE');
    expect(claims.audits).toHaveLength(1);
    expect(claims.audits[0].cursorTo).toBe(3);
    // archive 实体
    const archive = loadArchive('s1', { dir });
    expect(archive.entities.map((e) => e.kind)).toEqual(['hypothesis', 'evidence']);
    // 游标已推进（meta）
    expect(loadLoopSession('s1', { dir }).meta?.claimsCursor).toBe(3);
  });

  it('提取失败 → 游标不推进 + 审计带 error', async () => {
    await makeSession('s1', [msg('user', 'hi', 1)]);
    const failing: Extractor = async () => ({ ok: false, error: '模型不可用' });
    const r = await runClaimGovernance('s1', { extract: failing, dir, workspace: '/ws' });
    expect(r.ok).toBe(false);
    expect(r.cursorTo).toBe(r.cursorFrom);
    const claims = loadSessionClaims('s1', { dir });
    expect(claims.audits.some((a) => a.error === '模型不可用')).toBe(true);
    // 下轮同窗口重试可达（游标未动）。
    expect(loadLoopSession('s1', { dir }).meta?.claimsCursor).toBeUndefined();
  });

  it('去重：同 kind+text 二次提取不重复入库', async () => {
    // 两轮治理各一个非空窗口（≥9 条消息：第一轮 8 条、第二轮 2 条）。
    await makeSession('s1', Array.from({ length: 10 }, (_, i) => msg('user', `消息 ${i}`, i + 1)));
    const single: Extractor = async () => ({
      ok: true,
      output: {
        archiveEntities: [{ kind: 'finding', text: '结论 X' }],
        researchEvents: [],
        claims: [{ kind: 'fact', text: '事实 Y', searchTerms: ['Y'], salience: 0.6 }],
      },
    });
    await runClaimGovernance('s1', { extract: single, dir, workspace: '/ws' });
    const r2 = await runClaimGovernance('s1', { extract: single, dir, workspace: '/ws' });
    expect(r2.ok).toBe(true);
    expect(r2.deduped).toBeGreaterThanOrEqual(2); // claim + archive 各一
    const claims = loadSessionClaims('s1', { dir });
    expect(claims.claims.filter((c) => c.status === 'active')).toHaveLength(1);
    expect(loadArchive('s1', { dir }).entities).toHaveLength(1);
  });

  it('冲突收敛：同 subject 新 fact → 旧 active 变 superseded,新条记 supersedes', async () => {
    await makeSession('s1', Array.from({ length: 10 }, (_, i) => msg('user', `消息 ${i}`, i + 1)));
    const extractor: Extractor = async () => ({
      ok: true,
      output: {
        archiveEntities: [],
        researchEvents: [],
        claims: [{ kind: 'fact', text: '第一版事实', subject: '目标状态', searchTerms: [], salience: 0.7 }],
      },
    });
    const extractor2: Extractor = async () => ({
      ok: true,
      output: {
        archiveEntities: [],
        researchEvents: [],
        claims: [{ kind: 'fact', text: '第二版事实（修正）', subject: '目标状态', searchTerms: [], salience: 0.7 }],
      },
    });
    await runClaimGovernance('s1', { extract: extractor, dir, workspace: '/ws' });
    const r2 = await runClaimGovernance('s1', { extract: extractor2, dir, workspace: '/ws' });
    expect(r2.superseded).toBe(1);
    const claims = loadSessionClaims('s1', { dir });
    const active = claims.claims.filter((c) => c.status === 'active');
    const old = claims.claims.filter((c) => c.status === 'superseded');
    expect(active).toHaveLength(1);
    expect(active[0].text).toContain('第二版');
    expect(old).toHaveLength(1);
    expect(active[0].supersedes).toBe(old[0].id);
  });

  it('衰减归档：老条目 salience 衰减低于阈值 → archived', async () => {
    await makeSession('s1', Array.from({ length: 10 }, (_, i) => msg('user', `消息 ${i}`, i + 1)));
    const low: Extractor = async () => ({
      ok: true,
      output: {
        archiveEntities: [],
        researchEvents: [],
        claims: [{ kind: 'fact', text: '琐事', searchTerms: [], salience: 0.16 }],
      },
    });
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    await runClaimGovernance('s1', { extract: low, dir, workspace: '/ws', now: () => t0 });
    // 中间一轮治理（+5 天）不得给触点续命——lastTouchedAt 必须保持 t0
    // （否则每 30 分钟扫描会让半衰期衰减永久冻结）。
    const empty: Extractor = async () => ({ ok: true, output: { archiveEntities: [], researchEvents: [], claims: [] } });
    await runClaimGovernance('s1', { extract: empty, dir, workspace: '/ws', now: () => t0 + 5 * 24 * 3600_000 });
    expect(loadSessionClaims('s1', { dir }).claims[0].lastTouchedAt).toBe(new Date(t0).toISOString());
    // 时间推进 60 天（两个半衰期:0.16 → 0.04）→ 归档。
    await runClaimGovernance('s1', { extract: empty, dir, workspace: '/ws', now: () => t0 + 60 * 24 * 3600_000 });
    const claims = loadSessionClaims('s1', { dir });
    expect(claims.claims[0].status).toBe('archived');
  });
});

describe('admitExtraction / parseExtractionJson（纯函数）', () => {
  it('准入：非法枚举/空文本被滤除；findingType 运行时枚举兜底', () => {
    const r = admitExtraction({
      archiveEntities: [
        { kind: 'hypothesis', text: '合法' },
        { kind: 'bogus' as never, text: '非法 kind' },
        { kind: 'finding', text: '   ' },
        { kind: 'finding', text: '合法结论', findingType: 'primitive' },
        { kind: 'finding', text: '非法 findingType', findingType: 'bogus' as never },
      ],
      researchEvents: [
        { taskKind: 'binary', outcome: 'success', summary: 'ok' },
        { taskKind: 'bogus', outcome: 'success', summary: 'x' },
      ],
      claims: [
        { kind: 'fact', text: 'ok', salience: 0.5 },
        { kind: 'fact', text: 'bad salience', salience: 1.5 },
        { kind: 'bogus' as never, text: 'x' },
      ],
    });
    expect(r.archiveEntities).toHaveLength(3);
    expect(r.archiveEntities[1].findingType).toBe('primitive');
    expect(r.archiveEntities[2].findingType).toBeUndefined(); // 非法枚举剥离
    expect(r.researchEvents).toHaveLength(1);
    expect(r.claims).toHaveLength(1);
  });

  it('JSON 提取：code fence 剥离 / 括号平衡截取 / 坏 JSON 报错', () => {
    const ok = parseExtractionJson('```json\n{"claims":[],"archiveEntities":[],"researchEvents":[]}\n```');
    expect(ok.ok).toBe(true);
    const dirty = parseExtractionJson('前缀废话 {"claims":[]} 后缀');
    expect(dirty.ok).toBe(true);
    const bad = parseExtractionJson('{claims: [unclosed');
    expect(bad.ok).toBe(false);
  });
});
