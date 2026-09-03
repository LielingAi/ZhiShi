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
import {
  insertEntry,
  openExpertStore,
  resetExpertStoreForTest,
  type ExpertDb,
} from '../expert/store';
import type { ValidatedExpertEntry } from '../expert/validate';

let dir: string;
const NOW = Date.parse('2026-08-14T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-research-'));
  resetMemoryStoreForTest();
  resetExpertStoreForTest();
});

afterEach(() => {
  resetMemoryStoreForTest();
  resetExpertStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

/** 造一条合法专家条目并落 expert.db，返回条目 id（expert_refs 校验的靶子）。 */
function seedExpertEntry(title: string, db?: ExpertDb): number {
  const expertDb = db ?? openExpertStore(dir);
  const value: ValidatedExpertEntry = {
    domain: 'pentest',
    kind: 'technique',
    title,
    applicability: '适用条件',
    content: '正文',
    criteria: '判据',
    provenance: 'user',
    reviewer: 'tester',
    sourceEventId: null,
    tags: '',
    enabled: true,
  };
  return insertEntry(expertDb, value, `hash-${title}`, NOW).id;
}

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

  it('workspace 过滤前置:limit 在过滤后生效(1.6.3 #6 截断错样本回归)', () => {
    // 本工作区只有最老的 2 条,其余工作区 3 条更新——旧形态「先 limit 3
    // 再按 workspace 过滤」会把本工作区事件挤出截断窗口,过滤出 0~1 条
    // 错样本(auto-run stall 判定由此失真);过滤前置后拿到全部 2 条。
    recordResearchEvent({ workspace: '/ws/mine', taskKind: 'binary', outcome: 'success', summary: 'mine-1' }, dir, NOW - 4000);
    recordResearchEvent({ workspace: '/ws/mine', taskKind: 'binary', outcome: 'fail', summary: 'mine-2' }, dir, NOW - 3000);
    recordResearchEvent({ workspace: '/ws/other', taskKind: 'binary', outcome: 'success', summary: 'other-1' }, dir, NOW - 2000);
    recordResearchEvent({ workspace: '/ws/other', taskKind: 'binary', outcome: 'success', summary: 'other-2' }, dir, NOW - 1000);
    recordResearchEvent({ workspace: '/ws/other', taskKind: 'binary', outcome: 'success', summary: 'other-3' }, dir, NOW);

    const rows = listResearchEvents({ baseDir: dir, workspace: '/ws/mine', limit: 3 });
    expect(rows.map((r) => r.summary)).toEqual(['mine-2', 'mine-1']);
    // 过滤后仍按 limit 截断(语义:本工作区最新 N 条)。
    expect(listResearchEvents({ baseDir: dir, workspace: '/ws/other', limit: 2 }).map((r) => r.summary))
      .toEqual(['other-3', 'other-2']);
  });

  it('workspace 比较走 workspacePathsEqual(尾斜杠等价);与其他过滤可叠加', () => {
    recordResearchEvent({ workspace: '/ws/mine', taskKind: 'binary', outcome: 'success', summary: 's1' }, dir, NOW - 1000);
    recordResearchEvent({ workspace: '/ws/mine', taskKind: 'ctf', outcome: 'stuck', summary: 's2' }, dir, NOW);

    expect(listResearchEvents({ baseDir: dir, workspace: '/ws/mine/' })).toHaveLength(2);
    expect(listResearchEvents({ baseDir: dir, workspace: '/ws/mine', taskKind: 'ctf' }).map((r) => r.summary)).toEqual(['s2']);
    expect(listResearchEvents({ baseDir: dir, workspace: '/ws/absent' })).toHaveLength(0);
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

describe('research_events：expert_refs 引用追踪（1.2.2）', () => {
  it('合法 expert_refs 落库并读回；无 refs 的事件 expertRefs 缺省（旧行为零变化）', () => {
    const e1 = seedExpertEntry('条目一');
    const e2 = seedExpertEntry('条目二');
    const ev = recordResearchEvent({
      workspace: '/ws/x', taskKind: 'pentest', outcome: 'success',
      summary: '按专家条目拿下目标', expertRefs: [e1, e2],
    }, dir, NOW);
    expect(ev.expertRefs).toEqual([e1, e2]);
    const back = listResearchEvents({ baseDir: dir });
    expect(back[0].expertRefs).toEqual([e1, e2]);

    const plain = recordResearchEvent({
      workspace: '/ws/x', taskKind: 'pentest', outcome: 'fail', summary: '无引用',
    }, dir, NOW + 1);
    expect(plain.expertRefs).toBeUndefined();
    expect(listResearchEvents({ baseDir: dir })[0].expertRefs).toBeUndefined();
  });

  it('不存在的条目 id 拒绝落库（库存在/不存在两路），且不落脏数据', () => {
    const existing = seedExpertEntry('真实条目');
    expect(() => recordResearchEvent({
      workspace: '/ws/x', taskKind: 'pentest', outcome: 'success',
      summary: 'x', expertRefs: [existing, 9999],
    }, dir, NOW)).toThrow(/不存在的专家条目 id：9999/);
    expect(listResearchEvents({ baseDir: dir })).toHaveLength(0);

    // expert.db 整个不存在 → 任何 id 都查无此条目
    const dir2 = mkdtempSync(join(tmpdir(), 'zhishi-research-noexpert-'));
    try {
      expect(() => recordResearchEvent({
        workspace: '/ws/x', taskKind: 'pentest', outcome: 'success',
        summary: 'x', expertRefs: [1],
      }, dir2, NOW)).toThrow(/expert_refs/);
    } finally {
      resetMemoryStoreForTest();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('非法 id（0 / 负数 / 小数）拒绝落库', () => {
    seedExpertEntry('条目');
    const base = { workspace: '/ws/x', taskKind: 'pentest' as const, outcome: 'success' as const, summary: 'x' };
    expect(() => recordResearchEvent({ ...base, expertRefs: [0] }, dir, NOW)).toThrow(/正整数/);
    expect(() => recordResearchEvent({ ...base, expertRefs: [-3] }, dir, NOW)).toThrow(/正整数/);
    expect(() => recordResearchEvent({ ...base, expertRefs: [1.5] }, dir, NOW)).toThrow(/正整数/);
    expect(listResearchEvents({ baseDir: dir })).toHaveLength(0);
  });

  it('老库（D1 时期表：无 distilled_at / expert_refs）幂等迁移出两列，旧数据无损', () => {
    resetMemoryStoreForTest();
    const nodeRequire = createRequire(import.meta.url);
    const Database = nodeRequire('better-sqlite3') as (p: string) => {
      exec: (sql: string) => unknown;
      prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: () => unknown[] };
      close: () => void;
    };
    const legacy = Database(join(dir, 'memory.db'));
    legacy.exec(`
      CREATE TABLE research_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, workspace TEXT NOT NULL, task_kind TEXT NOT NULL,
        outcome TEXT NOT NULL, bug_class TEXT, summary TEXT NOT NULL, trajectory_ref TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO research_events (ts, workspace, task_kind, outcome, summary)
        VALUES (${NOW - 1000}, '/ws/old', 'binary', 'success', '老事件');
    `);
    legacy.close();

    // 第一次打开：两列都 ALTER 出来；旧事件读回无 expertRefs
    const rows = listResearchEvents({ baseDir: dir });
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('老事件');
    expect(rows[0].expertRefs).toBeUndefined();

    // 第二次打开（重置连接缓存后重开同一文件）：迁移幂等不炸，新列可写
    resetMemoryStoreForTest();
    const e1 = seedExpertEntry('迁移后条目');
    const ev = recordResearchEvent({
      workspace: '/ws/old', taskKind: 'binary', outcome: 'stuck', summary: '新事件', expertRefs: [e1],
    }, dir, NOW);
    expect(ev.expertRefs).toEqual([e1]);
    expect(listResearchEvents({ baseDir: dir })).toHaveLength(2);
  });
});
