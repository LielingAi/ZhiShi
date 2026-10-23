/**
 * S1 任务存储层单测。
 *
 * 全部落盘都进 `mkdtempSync` 临时目录 —— 绝不碰真实 `~/.zhishi`（那里有用户
 * 真实任务索引，一次误写就是事故）。数据目录由 `new TaskStore({ dataDir })`
 * 显式注入，不走 `getZhiShiDataDir()`。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCrashRecovery,
  assertSafeTaskId,
  MAX_RUN_RECORDS,
  TaskNotFoundError,
  TaskStore,
  toEpochMs,
  toRfc3339,
  type StatusTransition,
  type Task,
  type TaskRunRecord,
  type TaskRuntimeEntry,
} from './store';

let dataDir: string;
let store: TaskStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zhishi-task-store-'));
  store = new TaskStore({ dataDir });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 造一条最小可读的任务行（字段与 Rust Task 必填项对齐）。 */
function makeTask(overrides: Partial<Task> = {}): Task {
  const now = 1_700_000_000_000;
  return {
    id: 'task-default',
    name: '默认任务',
    executor: 'agent',
    workspaceId: 'ws-1',
    workspacePath: '/w/ws-1',
    executionMode: 'once',
    sessionIds: [],
    status: 'todo',
    tags: [],
    createdAt: now,
    updatedAt: now,
    statusHistory: [],
    dispatchOrigin: 'direct',
    deleted: false,
    ...overrides,
  };
}

function readIndexLines(): string[] {
  const text = readFileSync(join(dataDir, 'tasks.jsonl'), 'utf-8');
  return text.split('\n').filter((line) => line.trim() !== '');
}

function seedIndex(tasks: Task[]): void {
  writeFileSync(
    join(dataDir, 'tasks.jsonl'),
    tasks.map((task) => `${JSON.stringify(task)}\n`).join(''),
    'utf-8'
  );
}

/** 静音 warn（坏行/恢复类用例本来就会打日志，别污染测试输出）。 */
function muteWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('applyCrashRecovery（崩溃恢复矩阵，照 Rust task.rs load_and_recover）', () => {
  const NOW = 1_800_000_000_000;
  const lastOf = (task: Task): StatusTransition => task.statusHistory[task.statusHistory.length - 1]!;

  it('running × recurring → 保持 running，追加 from==to 自环（actor=system / source=crash）', () => {
    const { tasks, changed } = applyCrashRecovery(
      [makeTask({ status: 'running', executionMode: 'recurring' })],
      NOW
    );
    expect(changed).toBe(true);
    expect(tasks[0]!.status).toBe('running');
    expect(tasks[0]!.updatedAt).toBe(NOW);
    expect(tasks[0]!.statusHistory).toHaveLength(1);
    expect(lastOf(tasks[0]!)).toEqual({
      from: 'running',
      to: 'running',
      at: NOW,
      actor: 'system',
      message: '上次运行被应用重启中断,调度器将在下次计划时间继续触发',
      source: 'crash',
    });
  });

  it('running × loop → 同样保持 running', () => {
    const { tasks } = applyCrashRecovery([makeTask({ status: 'running', executionMode: 'loop' })], NOW);
    expect(tasks[0]!.status).toBe('running');
    expect(lastOf(tasks[0]!).from).toBe(lastOf(tasks[0]!).to);
  });

  it('running × once / scheduled → blocked（重跑语义不明确，交用户裁决）', () => {
    const { tasks, changed } = applyCrashRecovery(
      [
        makeTask({ id: 'a', status: 'running', executionMode: 'once' }),
        makeTask({ id: 'b', status: 'running', executionMode: 'scheduled' }),
      ],
      NOW
    );
    expect(changed).toBe(true);
    for (const task of tasks) {
      expect(task.status).toBe('blocked');
      expect(lastOf(task)).toMatchObject({ to: 'blocked', actor: 'system', source: 'crash' });
      expect(lastOf(task).message).toBe('上次运行被应用重启中断,可重新派发以继续');
    }
    expect(tasks[0]!.statusHistory[0]).toMatchObject({ from: 'running', to: 'blocked' });
  });

  it('verifying × 任意模式 → blocked（交棒态不静默降级回 running）', () => {
    const { tasks } = applyCrashRecovery(
      [
        makeTask({ id: 'a', status: 'verifying', executionMode: 'recurring' }),
        makeTask({ id: 'b', status: 'verifying', executionMode: 'once' }),
      ],
      NOW
    );
    expect(tasks.map((t) => t.status)).toEqual(['blocked', 'blocked']);
    expect(tasks[0]!.statusHistory[0]).toMatchObject({ from: 'verifying', to: 'blocked' });
  });

  it('最后一条已是同款崩溃自环 → 不再追加（幂等，防一天刷一条）', () => {
    const already: StatusTransition = {
      from: 'running',
      to: 'running',
      at: NOW - 1000,
      actor: 'system',
      message: '上次运行被应用重启中断,调度器将在下次计划时间继续触发',
      source: 'crash',
    };
    const { tasks, changed } = applyCrashRecovery(
      [
        makeTask({
          status: 'running',
          executionMode: 'recurring',
          statusHistory: [already],
        }),
      ],
      NOW
    );
    expect(changed).toBe(false);
    expect(tasks[0]!.statusHistory).toHaveLength(1);
    expect(tasks[0]!.updatedAt).not.toBe(NOW);
  });

  it('非 running/verifying 的任务完全不动', () => {
    const { tasks, changed } = applyCrashRecovery(
      [
        makeTask({ id: 'a', status: 'done' }),
        makeTask({ id: 'b', status: 'blocked' }),
        makeTask({ id: 'c', status: 'todo' }),
      ],
      NOW
    );
    expect(changed).toBe(false);
    expect(tasks.map((t) => t.status)).toEqual(['done', 'blocked', 'todo']);
    expect(tasks.every((t) => t.statusHistory.length === 0)).toBe(true);
  });
});

describe('TaskStore 加载容错', () => {
  it('文件不存在 / 空文件 → 空表', async () => {
    expect(await store.load()).toEqual([]);
    writeFileSync(join(dataDir, 'tasks.jsonl'), '', 'utf-8');
    expect(await store.load()).toEqual([]);
    writeFileSync(join(dataDir, 'tasks.jsonl'), '\n\n  \n', 'utf-8');
    expect(await store.load()).toEqual([]);
  });

  it('坏行 warn 后跳过，好行照常读（不炸）', async () => {
    const warn = muteWarn();
    writeFileSync(
      join(dataDir, 'tasks.jsonl'),
      [
        JSON.stringify(makeTask({ id: 'good-1' })),
        'this is not json',
        JSON.stringify({ id: 'missing-required-fields' }),
        JSON.stringify(makeTask({ id: 'bad-status', status: 'wat' as never })),
        JSON.stringify(makeTask({ id: 'good-2' })),
        '',
      ].join('\n'),
      'utf-8'
    );
    const tasks = await store.load();
    expect(tasks.map((t) => t.id)).toEqual(['good-1', 'good-2']);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain('已跳过');
  });

  it('同 id 重复行 → 后者覆盖，加载结果不重复', async () => {
    muteWarn();
    seedIndex([
      makeTask({ id: 'dup', name: '旧名' }),
      makeTask({ id: 'dup', name: '新名' }),
    ]);
    const tasks = await store.load();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.name).toBe('新名');
  });

  it('load 会立即写回恢复结果；再次 load 不重复追加（幂等）', async () => {
    muteWarn();
    seedIndex([makeTask({ status: 'running', executionMode: 'once' })]);
    const first = await store.load();
    expect(first[0]!.status).toBe('blocked');
    expect(readFileSync(join(dataDir, 'tasks.jsonl'), 'utf-8')).toContain('"status":"blocked"');

    const second = await new TaskStore({ dataDir }).load();
    expect(second[0]!.status).toBe('blocked');
    expect(second[0]!.statusHistory).toHaveLength(1);
  });
});

describe('TaskStore 写入纪律', () => {
  it('20 个并发 upsert 全部保留（withFileLock 下读-改-写不丢行）', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `concurrent-${i}`);
    await Promise.all(
      ids.map((id, i) => store.upsert(makeTask({ id, name: id, createdAt: 1_700_000_000_000 + i })))
    );
    const lines = readIndexLines();
    expect(lines).toHaveLength(20);
    const onDisk = (await new TaskStore({ dataDir }).load()).map((t) => t.id).sort();
    expect(onDisk).toEqual([...ids].sort());
  });

  it('同 id 覆盖 → 不产生重复行', async () => {
    await store.upsert(makeTask({ id: 'same', name: '第一版' }));
    await store.upsert(makeTask({ id: 'same', name: '第二版' }));
    const lines = readIndexLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).name).toBe('第二版');
  });

  it('按 createdAt 升序整表重写（不按写入顺序）', async () => {
    await store.upsert(makeTask({ id: 'c', createdAt: 300 }));
    await store.upsert(makeTask({ id: 'a', createdAt: 100 }));
    await store.upsert(makeTask({ id: 'b', createdAt: 200 }));
    expect(readIndexLines().map((line) => JSON.parse(line).id)).toEqual(['a', 'b', 'c']);
  });

  it('不认识的字段原样保留；deleted=false 按 Rust 口径省略', async () => {
    await store.upsert(
      makeTask({
        id: 'extras',
        // 模拟 Rust 未来新增、本模块还不认识的字段
        ...({ futureField: { hello: 'world' } } as Partial<Task>),
      })
    );
    const row = JSON.parse(readIndexLines()[0]!);
    expect(row.futureField).toEqual({ hello: 'world' });
    expect('deleted' in row).toBe(false);
    expect((await store.load())[0]!.deleted).toBe(false);
  });

  it('写盘字段顺序照 Rust 结构体声明顺序', async () => {
    await store.upsert(
      makeTask({
        id: 'ordered',
        createdAt: 1,
        updatedAt: 2,
        tags: ['x'],
        description: '描述',
      })
    );
    expect(Object.keys(JSON.parse(readIndexLines()[0]!))).toEqual([
      'id',
      'name',
      'executor',
      'description',
      'workspaceId',
      'workspacePath',
      'executionMode',
      'sessionIds',
      'status',
      'tags',
      'createdAt',
      'updatedAt',
      'statusHistory',
      'dispatchOrigin',
    ]);
  });
});

describe('mutate（锁内 read-modify-write，S3 的写路径地基）', () => {
  it('两个并发 mutate 各 append 一条 history + 改不同字段 → 两条改动都在', async () => {
    await store.upsert(makeTask({ id: 'm-1' }));
    const appendTransition = (message: string): StatusTransition => ({
      from: 'todo',
      to: 'todo',
      at: 1,
      actor: 'system',
      message,
    });

    await Promise.all([
      store.mutate('m-1', (t) => ({
        ...t,
        statusHistory: [...t.statusHistory, appendTransition('first')],
        tags: ['a'],
      })),
      store.mutate('m-1', (t) => ({
        ...t,
        statusHistory: [...t.statusHistory, appendTransition('second')],
        description: '改自第二个写者',
      })),
    ]);

    // 从盘上重读（不走内存），确认两次改动都落了：
    const reloaded = (await new TaskStore({ dataDir }).load())[0]!;
    expect(reloaded.statusHistory.map((h) => h.message).sort()).toEqual(['first', 'second']);
    expect(reloaded.tags).toEqual(['a']);
    expect(reloaded.description).toBe('改自第二个写者');
    // 且没有产生重复行
    expect(readIndexLines()).toHaveLength(1);
  });

  it('updater 返回 null = 放弃写入（不写盘）', async () => {
    await store.upsert(makeTask({ id: 'm-2', name: '原文' }));
    const before = readFileSync(join(dataDir, 'tasks.jsonl'), 'utf-8');
    expect(await store.mutate('m-2', () => null)).toBeNull();
    expect(readFileSync(join(dataDir, 'tasks.jsonl'), 'utf-8')).toBe(before);
  });

  it('找不到 id 抛 TaskNotFoundError；updater 抛错时锁被释放（不死锁）', async () => {
    await expect(store.mutate('missing', (t) => t)).rejects.toBeInstanceOf(TaskNotFoundError);

    await store.upsert(makeTask({ id: 'm-3' }));
    await expect(
      store.mutate('m-3', () => {
        throw new Error('守卫拒绝');
      })
    ).rejects.toThrow('守卫拒绝');
    // 锁已释放：紧接着的写能拿到锁（拿不到会 FileBusy 超时）
    await expect(store.upsert(makeTask({ id: 'm-4' }))).resolves.toBeTruthy();
    expect(readIndexLines()).toHaveLength(2);
  });

  it('remove 硬删一行（建单回滚用），不存在时返回 false', async () => {
    await store.upsert(makeTask({ id: 'm-5' }));
    expect(await store.remove('m-5')).toBe(true);
    expect(readIndexLines()).toHaveLength(0);
    expect(await store.remove('m-5')).toBe(false);
  });
});

describe('id 安全（拼进 tasks/<id>/ 与 task_runs/<id>.jsonl 之前必须过）', () => {
  it('路径穿越被拒', () => {
    expect(() => store.docPath('../../etc/passwd', 'task')).toThrow(/taskId 非法/);
    expect(() => assertSafeTaskId('../escape')).toThrow(/taskId 非法/);
    expect(() => assertSafeTaskId('a/b')).toThrow(/taskId 非法/);
    expect(() => assertSafeTaskId('a\\b')).toThrow(/taskId 非法/);
  });

  it('Windows 保留设备名被拒（大小写不敏感）', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      expect(() => assertSafeTaskId(name)).toThrow(/保留设备名/i);
    }
  });

  it('非法字符 / 以点开头 / 过长 被拒', () => {
    expect(() => assertSafeTaskId('')).toThrow(/taskId 非法/);
    expect(() => assertSafeTaskId('.hidden')).toThrow(/taskId 非法/);
    expect(() => assertSafeTaskId('has space')).toThrow(/taskId 非法/);
    expect(() => assertSafeTaskId('名字')).toThrow(/taskId 非法/);
    expect(() => assertSafeTaskId('x'.repeat(129))).toThrow(/taskId 非法/);
  });

  it('合法 UUID / slug 通过，且落在 tasks/ 之下', () => {
    const uuid = '8f14e45f-ceea-467f-a8e0-1c0f9c1a2b3c';
    expect(assertSafeTaskId(uuid)).toBe(uuid);
    expect(store.docPath(uuid, 'task')).toBe(join(dataDir, 'tasks', uuid, 'task.md'));
    expect(store.docPath('my_task-1', 'progress')).toBe(join(dataDir, 'tasks', 'my_task-1', 'progress.md'));
  });
});

describe('运行态读写（task_runtime.json）', () => {
  it('writeRuntime → readRuntime 往返；lastExecutedAt 是 RFC3339 字符串', async () => {
    const at = '2026-05-01T12:00:00.123Z';
    const entries: TaskRuntimeEntry[] = [
      {
        taskId: 't-1',
        sessionId: 'sess-1',
        executionCount: 3,
        lastExecutedAt: at,
        lastRunOk: true,
        lastRunDurationMs: 4321,
        armed: true,
      },
      { taskId: 't-0', sessionId: 'sess-0', executionCount: 0, armed: false },
    ];
    await store.writeRuntime(entries);

    const onDisk = JSON.parse(readFileSync(join(dataDir, 'task_runtime.json'), 'utf-8'));
    expect(onDisk).toEqual({ entries: [expect.objectContaining({ taskId: 't-0' }), expect.objectContaining({ taskId: 't-1' })] });
    expect(typeof onDisk.entries[1].lastExecutedAt).toBe('string');

    const back = await store.readRuntime();
    expect(back.map((e) => e.taskId)).toEqual(['t-0', 't-1']);
    expect(back[1]).toEqual(entries[0]);
    expect(toEpochMs(back[1]!.lastExecutedAt)).toBe(Date.parse(at));
  });

  it('文件缺失 → 空表；整体坏 JSON → warn 后空表且不覆盖原文件', async () => {
    expect(await store.readRuntime()).toEqual([]);
    const warn = muteWarn();
    writeFileSync(join(dataDir, 'task_runtime.json'), '{ not json', 'utf-8');
    expect(await store.readRuntime()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dataDir, 'task_runtime.json'), 'utf-8')).toBe('{ not json');
  });

  it('单条坏条目只跳过该条，其它运行态照常读出', async () => {
    muteWarn();
    writeFileSync(
      join(dataDir, 'task_runtime.json'),
      JSON.stringify({
        entries: [{ taskId: 'ok', sessionId: 's', armed: true }, { sessionId: 'no-task-id' }],
      }),
      'utf-8'
    );
    const entries = await store.readRuntime();
    expect(entries.map((e) => e.taskId)).toEqual(['ok']);
  });

  it('读出来 → 整份写回：不认识的运行态字段不丢', async () => {
    writeFileSync(
      join(dataDir, 'task_runtime.json'),
      JSON.stringify({
        entries: [{ taskId: 't-x', sessionId: 's', armed: true, futureRuntimeField: 42 }],
      }),
      'utf-8'
    );
    await store.writeRuntime(await store.readRuntime());
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'task_runtime.json'), 'utf-8'));
    expect(onDisk.entries[0].futureRuntimeField).toBe(42);
    expect(onDisk.entries[0].taskId).toBe('t-x');
  });

  it('toEpochMs / toRfc3339 纯函数行为', () => {
    expect(toEpochMs('2026-05-01T12:00:00.123Z')).toBe(1_777_636_800_123);
    expect(toEpochMs('2026-05-01T20:00:00+08:00')).toBe(1_777_636_800_000);
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs('')).toBeNull();
    expect(toEpochMs('不是时间')).toBeNull();
    expect(toEpochMs(toRfc3339(1_700_000_000_000))).toBe(1_700_000_000_000);
  });
});

describe('执行历史（task_runs/<id>.jsonl）', () => {
  const runOf = (ts: number, ok = true): TaskRunRecord => ({ ts, ok, durationMs: ts % 1000 });

  it('appendRun 后 readRuns 按时间序返回最近 N 条', async () => {
    for (const ts of [1, 2, 3, 4, 5]) {
      await store.appendRun('t-runs', runOf(ts));
    }
    const all = await store.readRuns('t-runs');
    expect(all.map((r) => r.ts)).toEqual([1, 2, 3, 4, 5]);
    expect((await store.readRuns('t-runs', 2)).map((r) => r.ts)).toEqual([4, 5]);
    expect(await store.readRuns('no-such-task')).toEqual([]);
  });

  it('记录形态与 Rust 同形（content/error 恒存在，缺省为 null）', async () => {
    await store.appendRun('t-shape', { ts: 1, ok: false, durationMs: 9, error: '炸了' });
    const line = JSON.parse(
      readFileSync(join(dataDir, 'task_runs', 't-shape.jsonl'), 'utf-8').trim()
    );
    expect(line).toEqual({ ts: 1, ok: false, durationMs: 9, content: null, error: '炸了' });
  });

  it('超 500 行整体截断，只保留最近 500 行', async () => {
    const path = join(dataDir, 'task_runs', 't-many.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      Array.from({ length: MAX_RUN_RECORDS + 2 }, (_, i) => JSON.stringify(runOf(i))).join('\n') + '\n',
      'utf-8'
    );
    await store.appendRun('t-many', runOf(9_999));
    const lines = readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(MAX_RUN_RECORDS);
    expect(JSON.parse(lines[lines.length - 1]!).ts).toBe(9_999);
    expect(JSON.parse(lines[0]!).ts).toBe(3); // 502+1 行 → 丢掉最前面 3 条
  });

  it('readRuns 默认只回最近 100 条；坏行 warn 后跳过', async () => {
    const path = join(dataDir, 'task_runs', 't-tail.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      Array.from({ length: 120 }, (_, i) => JSON.stringify(runOf(i))).join('\n') + '\nbroken-line\n',
      'utf-8'
    );
    const warn = muteWarn();
    const tail = await store.readRuns('t-tail');
    // 窗口是「最后 100 ***行***」（与 Rust `.rev().take(100).filter_map(..)`
    // 同口径）：坏行占掉一个窗口名额，所以有效记录是 99 条。
    expect(tail).toHaveLength(99);
    expect(tail[0]!.ts).toBe(21);
    expect(tail[tail.length - 1]!.ts).toBe(119);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('appendRun / readRuns 对任务 id 做安全校验', async () => {
    await expect(store.appendRun('../../evil', runOf(1))).rejects.toThrow(/taskId 非法/);
    await expect(store.readRuns('../../evil')).rejects.toThrow(/taskId 非法/);
  });
});

describe('文档路径', () => {
  it('docPath 返回绝对路径，四种文档都在 <dataDir>/tasks/<id>/ 下', () => {
    expect(store.docPath('t-doc', 'task')).toBe(join(dataDir, 'tasks', 't-doc', 'task.md'));
    expect(store.docPath('t-doc', 'verify')).toBe(join(dataDir, 'tasks', 't-doc', 'verify.md'));
    expect(store.docPath('t-doc', 'progress')).toBe(join(dataDir, 'tasks', 't-doc', 'progress.md'));
    expect(store.docPath('t-doc', 'alignment')).toBe(join(dataDir, 'tasks', 't-doc', 'alignment.md'));
    expect(store.docsDirFor('t-doc')).toBe(dirname(store.docPath('t-doc', 'task')));
  });
});
