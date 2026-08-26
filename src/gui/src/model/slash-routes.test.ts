/**
 * / 命令路由单测（1.3.1 ④）：逐条对照 zhishi.ts 契约断言端点与 payload。
 */

import { describe, expect, it } from 'vitest';

import {
  exportResultToast,
  forkTargets,
  noEnvToast,
  rewindTargets,
  slashPayload,
  slashRoute,
  SLASH_ROUTES,
} from './slash-routes';
import type { StreamItem } from './blocks';

const envCtx = { envKey: 'pwn@docker', workspace: '/work' };
const hostCtx = { envKey: null, workspace: '/work' };

describe('slashRoute（命令 → 端点映射）', () => {
  it('环境命令走 admin environment/*', () => {
    expect(slashRoute('snapshot')?.endpoint).toEqual({ kind: 'admin', route: 'environment/snapshot' });
    expect(slashRoute('rollback')?.endpoint).toEqual({ kind: 'admin', route: 'environment/rollback' });
    expect(slashRoute('extract')?.endpoint).toEqual({ kind: 'admin', route: 'environment/extract' });
  });

  it('线程命令走 HTTP 端点', () => {
    expect(slashRoute('rewind')?.endpoint).toEqual({ kind: 'http', method: 'POST', path: '/chat/rewind' });
    expect(slashRoute('fork')?.endpoint).toEqual({ kind: 'http', method: 'POST', path: '/sessions/fork' });
    expect(slashRoute('queue')?.endpoint).toEqual({ kind: 'http', method: 'GET', path: '/chat/queue/status' });
  });

  it('tasks / export 走 admin', () => {
    expect(slashRoute('tasks')?.endpoint).toEqual({ kind: 'admin', route: 'task/list' });
    expect(slashRoute('export')?.endpoint).toEqual({ kind: 'admin', route: 'report/export' });
  });

  it('未知命令 → null', () => {
    expect(slashRoute('nope')).toBeNull();
  });
});

describe('slashPayload', () => {
  it('snapshot：可选名（空名不带 name 字段）', () => {
    expect(slashPayload(SLASH_ROUTES.snapshot, envCtx, 'clean')).toEqual({ id: 'pwn@docker', name: 'clean' });
    expect(slashPayload(SLASH_ROUTES.snapshot, envCtx, '')).toEqual({ id: 'pwn@docker' });
  });

  it('rollback / extract：id + 参数', () => {
    expect(slashPayload(SLASH_ROUTES.rollback, envCtx, 'clean')).toEqual({ id: 'pwn@docker', snapshot: 'clean' });
    expect(slashPayload(SLASH_ROUTES.extract, envCtx, '/work/flag.txt')).toEqual({
      id: 'pwn@docker',
      guestPath: '/work/flag.txt',
      workspace: '/work',
    });
  });

  it('rewind / fork：wire 消息 id 载荷', () => {
    expect(slashPayload(SLASH_ROUTES.rewind, hostCtx, '12')).toEqual({ userMessageId: '12' });
    expect(slashPayload(SLASH_ROUTES.fork, hostCtx, '12')).toEqual({ messageId: '12' });
  });

  it('export：需 workspace；无 workspace → null', () => {
    expect(slashPayload(SLASH_ROUTES.export, envCtx)).toEqual({ workspace: '/work' });
    expect(slashPayload(SLASH_ROUTES.export, { envKey: null, workspace: null })).toBeNull();
  });

  it('export：sanitize 参数透传（1.3.5 脱敏导出）', () => {
    expect(slashPayload(SLASH_ROUTES.export, envCtx, 'sanitize')).toEqual({
      workspace: '/work',
      sanitize: true,
    });
    expect(slashPayload(SLASH_ROUTES.export, envCtx, '  sanitize  ')).toEqual({
      workspace: '/work',
      sanitize: true,
    });
    // 非 sanitize 的非法值不透传（用法校验在 store 侧）
    expect(slashPayload(SLASH_ROUTES.export, envCtx, 'sanitized')).toEqual({ workspace: '/work' });
  });

  it('needsEnv 命令在宿主未锚定时 → null', () => {
    expect(slashPayload(SLASH_ROUTES.snapshot, hostCtx, 'x')).toBeNull();
    expect(slashPayload(SLASH_ROUTES.extract, hostCtx, '/x')).toBeNull();
  });

  it('noEnvToast 文案', () => {
    expect(noEnvToast('snapshot')).toContain('宿主未锚定环境');
  });
});

describe('rewindTargets / forkTargets（wire id 提取）', () => {
  const items: StreamItem[] = [
    {
      kind: 'turn',
      id: 't1',
      seq: 1,
      userText: '帮我分析这个崩溃',
      steering: false,
      conclusion: '',
      conclusionStreaming: false,
      details: [],
      status: 'complete',
      srvIds: ['0', '1'],
      createdAt: 1,
    },
    {
      kind: 'turn',
      id: 't2',
      seq: 2,
      userText: '再试试 ret2win 的第二条链，这一条非常长的消息超过四十个字符就要被截断展示出来',
      steering: false,
      conclusion: '',
      conclusionStreaming: false,
      details: [],
      status: 'complete',
      srvIds: ['2'],
      createdAt: 2,
    },
    { kind: 'divider', id: 'd1', seq: 3, text: '---' },
  ];

  it('只取 user turn（srvIds 首个即 user wire id），跳过非 turn', () => {
    const targets = rewindTargets(items);
    expect(targets.map((t) => t.id)).toEqual(['0', '2']);
  });

  it('长文本截断到 40 字符', () => {
    const targets = rewindTargets(items);
    expect(targets[1].label.endsWith('…')).toBe(true);
    expect(targets[1].label.length).toBeLessThanOrEqual(41);
  });

  it('空 userText / 无 srvId 的 turn 不进候选', () => {
    const noUser = rewindTargets([
      {
        kind: 'turn',
        id: 't3',
        seq: 4,
        userText: '',
        steering: false,
        conclusion: 'x',
        conclusionStreaming: false,
        details: [],
        status: 'complete',
        srvIds: ['3'],
        createdAt: 3,
      },
    ]);
    expect(noUser).toEqual([]);
  });

  it('fork 目标 = rewind 目标（同 wire 语义）', () => {
    expect(forkTargets(items)).toEqual(rewindTargets(items));
  });
});

describe('exportResultToast', () => {
  it('带证据数；缺 data 回落 report', () => {
    expect(exportResultToast({ reportDir: '/w/output/reports/x', evidenceCount: 3 })).toContain('/w/output/reports/x');
    expect(exportResultToast(undefined)).toContain('report');
  });

  it('1.3.5：脱敏与降级标注（degraded 是 string[]，TUI 同口径）', () => {
    expect(exportResultToast({ reportDir: 'r', evidenceCount: 2, sanitized: true })).toBe(
      '报告已导出：r · 证据 2 件 · 已脱敏',
    );
    expect(exportResultToast({ reportDir: 'r', degraded: ['a', 'b'] })).toBe(
      '报告已导出：r · 降级 2 项',
    );
    expect(exportResultToast({ degraded: 'not-array', sanitized: false })).toBe('报告已导出：report');
  });
});
