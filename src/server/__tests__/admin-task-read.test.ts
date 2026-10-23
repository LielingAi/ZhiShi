/**
 * S2 — 任务读路径本地化（`task/list` / `task/get` / `task/read-doc`）。
 *
 * 背景：这三条原先转发 Rust Management API，Tauri 应用不在时必然失败 —— 而
 * 产品只剩 Go TUI 直连裸 sidecar，于是任务面板永远 failed。S2 改成直接读
 * Node 侧 TaskStore（`<数据目录>/tasks.jsonl` + `tasks/<id>/*.md`）。
 *
 * 本文件锁住三件事：
 *   1. 过滤/排序口径与 Rust `task.rs::TaskStore::list` 一致（cli/TUI 依赖）；
 *   2. 响应形状逐字对齐（`data` 是数组本身 / `data.task.docs` / `data.content`）；
 *   3. 失败语义（非法 id / 未知任务 / 非法 doc）不炸、不透传异常栈。
 *
 * 全部数据落在 `mkdtempSync` 临时目录，绝不读写真实 `~/.zhishi`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleTaskGet, handleTaskList, handleTaskReadDoc } from '../admin-api';
import { clearTaskConclusions, recordTaskConclusion } from '../cron/task-conclusions';

const ORIGINAL_DATA_DIR = process.env.ZHISHI_DATA_DIR;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zhishi-task-read-'));
  // 读路径靠 getZhiShiDataDir() 解析数据目录；handler 每次请求现构造 store，
  // 所以这里改 env 就能生效（模块加载时不固化路径——S1 特意这么设计的）。
  process.env.ZHISHI_DATA_DIR = dataDir;
  clearTaskConclusions();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  clearTaskConclusions();
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = ORIGINAL_DATA_DIR;
});

interface SeedTask {
  id: string;
  name?: string;
  workspaceId?: string;
  status?: string;
  executionMode?: string;
  tags?: string[];
  updatedAt?: number;
  createdAt?: number;
  deleted?: boolean;
  dispatchOrigin?: string;
}

/** 造一行与 Rust `Task` 必填字段对齐的任务行。 */
function taskRow(seed: SeedTask): Record<string, unknown> {
  const createdAt = seed.createdAt ?? 1_700_000_000_000;
  return {
    id: seed.id,
    name: seed.name ?? seed.id,
    executor: 'agent',
    workspaceId: seed.workspaceId ?? 'ws-1',
    workspacePath: '/w/ws-1',
    executionMode: seed.executionMode ?? 'once',
    sessionIds: [],
    status: seed.status ?? 'todo',
    tags: seed.tags ?? [],
    createdAt,
    updatedAt: seed.updatedAt ?? createdAt,
    statusHistory: [],
    dispatchOrigin: seed.dispatchOrigin ?? 'direct',
    ...(seed.deleted === true ? { deleted: true } : {}),
  };
}

function seedTasks(rows: SeedTask[]): void {
  writeFileSync(
    join(dataDir, 'tasks.jsonl'),
    rows.map((r) => `${JSON.stringify(taskRow(r))}\n`).join(''),
    'utf-8'
  );
}

/** 建一份任务文档（`doc` 为文件名，如 `task.md`）。 */
function seedDoc(taskId: string, doc: string, content: string): void {
  const dir = join(dataDir, 'tasks', taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, doc), content, 'utf-8');
}

type TaskRowOut = { id: string; conclusion?: string | null; [k: string]: unknown };

async function listRows(payload: Record<string, unknown> = {}): Promise<TaskRowOut[]> {
  const res = await handleTaskList(payload);
  expect(res.success).toBe(true);
  // 形状硬要求：data 是**数组本身**（不是 {tasks}），TUI / CLI 都按数组解。
  expect(Array.isArray(res.data)).toBe(true);
  return res.data as TaskRowOut[];
}

describe('task/list — 过滤与排序（口径照 Rust TaskStore::list）', () => {
  it('workspaceId 精确匹配（不是前缀/子串）', async () => {
    seedTasks([
      { id: 'a', workspaceId: 'ws-1' },
      { id: 'b', workspaceId: 'ws-2' },
      { id: 'c', workspaceId: 'ws-10' },
    ]);
    expect((await listRows({ workspaceId: 'ws-1' })).map((t) => t.id)).toEqual(['a']);
    expect((await listRows({ workspaceId: 'ws-1', includeSystem: true })).length).toBe(1);
    expect((await listRows()).map((t) => t.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('status 支持逗号分隔多值', async () => {
    seedTasks([
      { id: 'todo-1', status: 'todo' },
      // 用 recurring：跑着的 recurring 任务经崩溃恢复后仍是 running（once 会被
      // 恢复成 blocked，那样就测不到 running 过滤了）。
      { id: 'run-1', status: 'running', executionMode: 'recurring' },
      { id: 'done-1', status: 'done' },
    ]);
    const rows = await listRows({ status: 'todo,done' });
    expect(rows.map((t) => t.id).sort()).toEqual(['done-1', 'todo-1']);
    // 单个值同样可用
    expect((await listRows({ status: 'running' })).map((t) => t.id)).toEqual(['run-1']);
    // 无法识别的状态 → 不过滤（Rust parse_status_filter 返回 None 的语义）
    expect((await listRows({ status: 'bogus' })).length).toBe(3);
  });

  it('tag 是大小写不敏感的精确匹配', async () => {
    seedTasks([
      { id: 'pwn', tags: ['PWN'] },
      { id: 'pwn-vm', tags: ['pwn-vm'] },
      { id: 'other', tags: ['web'] },
    ]);
    expect((await listRows({ tag: 'pwn' })).map((t) => t.id)).toEqual(['pwn']);
    expect((await listRows({ tag: 'pwn-vm' })).map((t) => t.id)).toEqual(['pwn-vm']);
  });

  it('includeDeleted 缺省过滤已删除任务', async () => {
    seedTasks([
      { id: 'alive' },
      { id: 'gone', deleted: true },
    ]);
    expect((await listRows()).map((t) => t.id)).toEqual(['alive']);
    expect((await listRows({ includeDeleted: true })).map((t) => t.id)).toEqual(['alive', 'gone']);
  });

  it('includeSystem 缺省过滤 dispatchOrigin=system 的内置任务', async () => {
    seedTasks([
      { id: 'mine', dispatchOrigin: 'direct' },
      { id: 'arc', dispatchOrigin: 'system' },
    ]);
    expect((await listRows()).map((t) => t.id)).toEqual(['mine']);
    expect((await listRows({ includeSystem: true })).map((t) => t.id).sort()).toEqual([
      'arc',
      'mine',
    ]);
  });

  it('按 updatedAt 降序（最近动过的排前面）', async () => {
    seedTasks([
      { id: 'old', createdAt: 1, updatedAt: 10 },
      { id: 'new', createdAt: 2, updatedAt: 30 },
      { id: 'mid', createdAt: 3, updatedAt: 20 },
    ]);
    expect((await listRows()).map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  it('每行贴 conclusion（无结论 → null），空索引 → 空数组', async () => {
    seedTasks([{ id: 'arc-1' }, { id: 'arc-2' }]);
    recordTaskConclusion('arc-1', '完成:拿到 flag');
    const rows = await listRows();
    expect(rows.map((t) => t.id).sort()).toEqual(['arc-1', 'arc-2']);
    expect(rows.find((t) => t.id === 'arc-1')?.conclusion).toBe('完成:拿到 flag');
    expect(rows.find((t) => t.id === 'arc-2')?.conclusion).toBeNull();

    // 索引文件不存在 → 空数组而不是报错
    rmSync(join(dataDir, 'tasks.jsonl'));
    expect(await listRows()).toEqual([]);
  });
});

describe('task/get — 单任务 + docs 路径', () => {
  it('docs 只给存在的文件路径（taskMd 恒有）', async () => {
    seedTasks([{ id: 't-docs', name: '带文档的任务' }]);
    seedDoc('t-docs', 'task.md', '执行任务：做事');
    seedDoc('t-docs', 'progress.md', '进度：一半');

    const res = await handleTaskGet({ id: 't-docs' });
    expect(res.success).toBe(true);
    const data = res.data as { id: string; name: string; docs: Record<string, string> };
    expect(data.id).toBe('t-docs');
    expect(data.name).toBe('带文档的任务');
    expect(data.docs.dir).toBe(join(dataDir, 'tasks', 't-docs'));
    expect(data.docs.taskMd).toBe(join(dataDir, 'tasks', 't-docs', 'task.md'));
    expect(data.docs.progressMd).toBe(join(dataDir, 'tasks', 't-docs', 'progress.md'));
    // 没写的两份不出现（不是 null，是没有这个键）
    expect('verifyMd' in data.docs).toBe(false);
    expect('alignmentMd' in data.docs).toBe(false);
  });

  it('未知 id → success:false（错误码 not_found，且不带异常栈）', async () => {
    seedTasks([{ id: 'only-one' }]);
    const res = await handleTaskGet({ id: 'does-not-exist' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('not_found');
    expect(res.data).toBeUndefined();
  });

  it('缺少 id → success:false', async () => {
    const res = await handleTaskGet({});
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少任务 id');
  });
});

describe('task/read-doc — 文档读取', () => {
  it('正常读回原文', async () => {
    seedTasks([{ id: 't-read' }]);
    seedDoc('t-read', 'verify.md', '# 验收\n\n- 拿到 flag');
    const res = await handleTaskReadDoc({ id: 't-read', doc: 'verify' });
    expect(res.success).toBe(true);
    expect((res.data as { content: string }).content).toBe('# 验收\n\n- 拿到 flag');
  });

  it('文件不存在 → 空串（不报错，CLI 脚本要幂等）', async () => {
    seedTasks([{ id: 't-empty' }]);
    const res = await handleTaskReadDoc({ id: 't-empty', doc: 'alignment' });
    expect(res.success).toBe(true);
    expect((res.data as { content: string }).content).toBe('');
  });

  it('非法 doc → success:false，文案提示可用值', async () => {
    seedTasks([{ id: 't-baddoc' }]);
    const res = await handleTaskReadDoc({ id: 't-baddoc', doc: 'secrets' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('unknown doc name: secrets');
    expect(res.error).toContain('task|verify|progress|alignment');
  });

  it('非法 id（路径穿越）→ success:false，不透传栈、不读盘', async () => {
    seedTasks([{ id: 't-evil' }]);
    const res = await handleTaskReadDoc({ id: '../../etc/passwd', doc: 'task' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('taskId 非法');
    expect(res.error).not.toContain('at ');
  });

  it('任务不存在 → success:false（空串只表示"任务在、文档还没写"）', async () => {
    seedTasks([{ id: 't-only' }]);
    const res = await handleTaskReadDoc({ id: 't-missing', doc: 'task' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('task not found');
  });
});
