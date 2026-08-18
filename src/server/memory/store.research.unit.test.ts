// research_events 单测（安全研究员版 P1 D1）：结构化成败信号——
// 枚举校验（合法/非法/空）、CRUD、过滤查询、老库无损迁移。
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isResearchBugClass,
  isResearchOutcome,
  isResearchTaskKind,
  listResearchEvents,
  recordResearchEvent,
  resetMemoryStoreForTest,
  RESEARCH_BUG_CLASSES,
  RESEARCH_OUTCOMES,
  RESEARCH_TASK_KINDS,
} from './store';

let dir: string;
const NOW = Date.parse('2026-08-14T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-research-'));
  resetMemoryStoreForTest();
});

afterEach(() => {
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('research_events：枚举定义与校验', () => {
  it('枚举集合与设计一致（七研究域 + ctf 补充 / 三成败 / 漏洞类别）', () => {
    expect([...RESEARCH_TASK_KINDS]).toEqual([
      'binary', 'pentest', 'ai-security', 'redteam', 'malware', 'whitebox', 'intel', 'ctf',
    ]);
    expect([...RESEARCH_OUTCOMES]).toEqual(['success', 'fail', 'stuck']);
    expect([...RESEARCH_BUG_CLASSES]).toEqual([
      'stack-overflow', 'heap-overflow', 'uaf', 'double-free', 'oob-read', 'oob-write',
      'null-deref', 'int-overflow', 'format-string', 'type-confusion',
      'sql-injection', 'xss', 'ssrf', 'path-traversal', 'command-injection', 'xxe',
      'auth-bypass', 'deserialization', 'other',
    ]);
  });

  it('合法值通过，非法/空值拒绝', () => {
    expect(isResearchTaskKind('binary')).toBe(true);
    expect(isResearchTaskKind('ctf')).toBe(true); // D30:ctf 是补充域
    expect(isResearchTaskKind('web')).toBe(false);
    expect(isResearchTaskKind('')).toBe(false);

    expect(isResearchOutcome('success')).toBe(true);
    expect(isResearchOutcome('stuck')).toBe(true);
    expect(isResearchOutcome('timeout')).toBe(false);
    expect(isResearchOutcome('')).toBe(false);

    expect(isResearchBugClass('uaf')).toBe(true);
    expect(isResearchBugClass('other')).toBe(true);
    expect(isResearchBugClass('rce')).toBe(false);
    expect(isResearchBugClass('')).toBe(false);
  });
});

describe('research_events：recordResearchEvent / listResearchEvents', () => {
  it('记录一条完整事件并可按时间倒序列出', () => {
    const ev = recordResearchEvent({
      workspace: '/ws/pwn-1',
      taskKind: 'binary',
      outcome: 'success',
      bugClass: 'uaf',
      summary: 'pwnable.tw hacknote：fastbin dup 改 stdout 泄露 libc，拿 flag',
      trajectoryRef: 'traj/hacknote.md',
    }, dir, NOW);

    expect(ev.id).toBeGreaterThan(0);
    expect(ev.ts).toBe(NOW);
    expect(ev.bugClass).toBe('uaf');
    expect(ev.trajectoryRef).toBe('traj/hacknote.md');

    recordResearchEvent({
      workspace: '/ws/pwn-1',
      taskKind: 'pentest',
      outcome: 'stuck',
      summary: '靶机提权卡在内核版本不匹配',
    }, dir, NOW + 1000);

    const rows = listResearchEvents({ baseDir: dir });
    expect(rows).toHaveLength(2);
    expect(rows[0].summary).toContain('提权'); // 最新在前
    expect(rows[0].bugClass).toBeUndefined();
    expect(rows[0].trajectoryRef).toBeUndefined();
    expect(rows[1].bugClass).toBe('uaf');
  });

  it('非法枚举 / 空 workspace / 空 summary 拒绝落库', () => {
    const base = { workspace: '/ws/x', taskKind: 'binary' as const, outcome: 'success' as const, summary: 'ok' };
    expect(() => recordResearchEvent({ ...base, taskKind: 'web' as never }, dir, NOW)).toThrow(/task_kind/);
    expect(() => recordResearchEvent({ ...base, outcome: 'win' as never }, dir, NOW)).toThrow(/outcome/);
    expect(() => recordResearchEvent({ ...base, bugClass: 'rce' as never }, dir, NOW)).toThrow(/bug_class/);
    expect(() => recordResearchEvent({ ...base, workspace: '  ' }, dir, NOW)).toThrow(/workspace/);
    expect(() => recordResearchEvent({ ...base, summary: '' }, dir, NOW)).toThrow(/summary/);
    expect(listResearchEvents({ baseDir: dir })).toHaveLength(0);
  });

  it('按 taskKind / outcome 过滤 + limit 截断', () => {
    recordResearchEvent({ workspace: '/ws/a', taskKind: 'binary', outcome: 'success', summary: 's1' }, dir, NOW - 3000);
    recordResearchEvent({ workspace: '/ws/a', taskKind: 'binary', outcome: 'fail', summary: 's2' }, dir, NOW - 2000);
    recordResearchEvent({ workspace: '/ws/a', taskKind: 'ctf', outcome: 'success', summary: 's3' }, dir, NOW - 1000);
    recordResearchEvent({ workspace: '/ws/a', taskKind: 'intel', outcome: 'stuck', summary: 's4' }, dir, NOW);

    expect(listResearchEvents({ baseDir: dir, taskKind: 'binary' }).map((r) => r.summary)).toEqual(['s2', 's1']);
    expect(listResearchEvents({ baseDir: dir, outcome: 'success' }).map((r) => r.summary)).toEqual(['s3', 's1']);
    expect(listResearchEvents({ baseDir: dir, taskKind: 'binary', outcome: 'success' }).map((r) => r.summary)).toEqual(['s1']);
    expect(listResearchEvents({ baseDir: dir, limit: 2 }).map((r) => r.summary)).toEqual(['s4', 's3']);
  });

  it('老库无损：既有 memory.db 无 research_events 表，openDb 迁移建表后可正常读写', () => {
    // 手工造一个只有老表的 memory.db（模拟 D1 之前的数据库）。
    resetMemoryStoreForTest();
    const nodeRequire = createRequire(import.meta.url);
    const Database = nodeRequire('better-sqlite3') as (p: string) => {
      exec: (sql: string) => unknown;
      close: () => void;
    };
    const legacy = Database(join(dir, 'memory.db'));
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
        source TEXT, date TEXT, created_at INTEGER NOT NULL,
        last_touched_at INTEGER NOT NULL, expires_at INTEGER,
        salience REAL NOT NULL, usefulness REAL NOT NULL, content_key TEXT NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    legacy.close();

    // 迁移建表 + 写入 + 读回，全程不炸。
    const ev = recordResearchEvent({
      workspace: '/ws/legacy', taskKind: 'malware', outcome: 'fail', summary: '样本反调试，放弃动态分析',
    }, dir, NOW);
    expect(ev.id).toBeGreaterThan(0);
    const rows = listResearchEvents({ baseDir: dir, taskKind: 'malware' });
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('fail');
  });
});
