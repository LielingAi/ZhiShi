/**
 * S3 — 任务写路径本地化（create-direct / create-from-alignment / update /
 * update-status / append-session / archive / delete / write-doc）。
 *
 * 语义权威源是 Rust `task.rs`（状态机 / 守卫 / 合并顺序 / 错误码）。这里锁住
 * 的是「迁移后行为没变」：错误码仍是 `{code,message}` 的 JSON 串、响应形状仍是
 * `{success,data:{task|transition|…}}`、落盘顺序（文档先、索引后）不变。
 *
 * 全部数据落在 `mkdtempSync` 临时目录，绝不读写真实 `~/.zhishi`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleTaskAppendSession,
  handleTaskArchive,
  handleTaskCreateDirect,
  handleTaskCreateFromAlignment,
  handleTaskDelete,
  handleTaskGet,
  handleTaskList,
  handleTaskUpdate,
  handleTaskUpdateStatus,
  handleTaskWriteDoc,
} from '../admin-api';
import { readTrustLedger } from '../memory/trust';
import { resetMemoryStoreForTest } from '../memory/store';
import { createTaskStore } from '../task/store';

const ORIGINAL_DATA_DIR = process.env.ZHISHI_DATA_DIR;
const ORIGINAL_PORT = process.env.ZHISHI_PORT;

let dataDir: string;
let workspacePath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zhishi-task-write-'));
  process.env.ZHISHI_DATA_DIR = dataDir;
  workspacePath = join(dataDir, 'ws');
  mkdirSync(workspacePath, { recursive: true });
  // actor 推断依赖 ZHISHI_PORT：测试里必须固定成"用户终端"形态，
  // 否则跑在 AI 子进程 env 里时 actor 会变成 agent，守卫用例结果不同。
  delete process.env.ZHISHI_PORT;
});

afterEach(() => {
  // 信任账本落在 <数据目录>/memory.db，sqlite 连接是模块级缓存 —— Windows 上
  // 不先关连接，rmSync 会 EBUSY（既有惯例：见 claim-governance.unit.test.ts）。
  resetMemoryStoreForTest();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_PORT === undefined) delete process.env.ZHISHI_PORT;
  else process.env.ZHISHI_PORT = ORIGINAL_PORT;
});

function taskMdPath(id: string): string {
  return join(dataDir, 'tasks', id, 'task.md');
}

interface CreateOk {
  task: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  overridden?: string[];
  overridesRequested?: string[];
  nextSteps?: { dispatch: string };
}

/** 建一条最小任务并返回 id（多数用例的起手式）。 */
async function createTask(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await handleTaskCreateDirect({
    name: '示例任务',
    executor: 'agent',
    workspacePath,
    taskMdContent: '执行任务：做事',
    executionMode: 'once',
    ...overrides,
  });
  expect(res.success).toBe(true);
  const data = res.data as CreateOk;
  return String(data.task.id);
}

function errOf(res: { error?: string }): string {
  return String(res.error ?? '');
}

describe('create-direct', () => {
  it('成功：落索引 + 写 task.md + status=todo + 审计起点', async () => {
    const res = await handleTaskCreateDirect({
      name: '  带空格的名称  ',
      executor: 'agent',
      workspaceId: 'ws-1',
      workspacePath,
      taskMdContent: '执行任务：跑通 v2.4',
      executionMode: 'once',
      tags: ['a', 'b'],
    });
    expect(res.success).toBe(true);
    const data = res.data as CreateOk;
    const task = data.task;
    // name 已 trim（Rust 校验 trim 后的长度；落盘同样用 trim 后的值）
    expect(task.name).toBe('带空格的名称');
    expect(task.status).toBe('todo');
    expect(task.dispatchOrigin).toBe('direct');
    expect(task.deleted).toBe(false);
    expect(task.sessionIds).toEqual([]);
    expect(task.tags).toEqual(['a', 'b']);
    expect(task.createdAt).toBe(task.updatedAt);
    expect(task.statusHistory).toEqual([
      expect.objectContaining({ from: null, to: 'todo', actor: 'user', source: 'ui' }),
    ]);
    // id 是 UUID（路径安全）
    expect(String(task.id)).toMatch(/^[0-9a-f-]{36}$/);
    // task.md 落盘、内容原样
    expect(readFileSync(taskMdPath(String(task.id)), 'utf-8')).toBe('执行任务：跑通 v2.4');
    // 索引行也在
    const list = await handleTaskList({});
    expect((list.data as Array<{ id: string }>).map((t) => t.id)).toEqual([task.id]);
  });

  it('name 为空 / 超长 / 非字符串 → 拒绝且不落盘', async () => {
    const cases: Array<[unknown, RegExp]> = [
      ['', /task name is empty/],
      ['   ', /task name is empty/],
      [undefined, /task name is empty/],
      ['x'.repeat(121), /task name exceeds 120 chars/],
    ];
    for (const [name, pattern] of cases) {
      const res = await handleTaskCreateDirect({
        name,
        executor: 'agent',
        workspacePath,
        taskMdContent: 'x',
        executionMode: 'once',
      });
      expect(res.success).toBe(false);
      expect(errOf(res)).toMatch(pattern);
    }
    // 120 字符（中文按字符数，不按字节）刚好通过
    const ok = await handleTaskCreateDirect({
      name: '任'.repeat(120),
      executor: 'agent',
      workspacePath,
      taskMdContent: 'x',
      executionMode: 'once',
    });
    expect(ok.success).toBe(true);
    const list = await handleTaskList({});
    expect((list.data as unknown[]).length).toBe(1);
  });

  it('相对 workspacePath → 拒绝；缺省 → 允许（裸 sidecar 的 CLI 不给默认值）', async () => {
    const bad = await handleTaskCreateDirect({
      name: '相对路径',
      executor: 'agent',
      workspacePath: 'relative/path',
      taskMdContent: 'x',
      executionMode: 'once',
    });
    expect(bad.success).toBe(false);
    expect(errOf(bad)).toMatch(/workspacePath must be absolute/);

    const ok = await handleTaskCreateDirect({
      name: '无工作区',
      executor: 'agent',
      taskMdContent: 'x',
      executionMode: 'once',
    });
    expect(ok.success).toBe(true);
    expect((ok.data as CreateOk).task.workspacePath).toBe('');
  });

  it('overrides 回读：落盘值进 overridden / overrides / nextSteps', async () => {
    const res = await handleTaskCreateDirect({
      name: '带覆盖',
      executor: 'agent',
      workspacePath,
      taskMdContent: 'x',
      executionMode: 'once',
      model: 'k3',
    });
    const data = res.data as CreateOk;
    expect(data.overridden).toEqual(['model']);
    expect(data.overrides?.model).toBe('k3');
    expect(data.overridesRequested).toEqual(['model']);
    expect(data.nextSteps?.dispatch).toContain(`zhishi task run ${String(data.task.id)}`);
  });

  it('providerId 未配 model → 拒绝（PRD 0.2.9 配对不变式）', async () => {
    const res = await handleTaskCreateDirect({
      name: '坏 provider',
      executor: 'agent',
      workspacePath,
      taskMdContent: 'x',
      executionMode: 'once',
      providerId: 'openai-1',
    });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('providerId 必须与 model 配对设置');
  });

  it('cron 表达式在建单口校验（S4 的 croner 解析器接线）', async () => {
    const bad = await handleTaskCreateDirect({
      name: '坏 cron',
      executor: 'agent',
      workspacePath,
      taskMdContent: 'x',
      executionMode: 'recurring',
      cronExpression: 'every 5 minutes please',
    });
    expect(bad.success).toBe(false);
    expect(errOf(bad)).toContain('cron expression invalid');

    const ok = await handleTaskCreateDirect({
      name: '好 cron',
      executor: 'agent',
      workspacePath,
      taskMdContent: 'x',
      executionMode: 'recurring',
      cronExpression: '0 9 * * 1-5',
      cronTimezone: 'Asia/Shanghai',
    });
    expect(ok.success).toBe(true);
    expect((ok.data as CreateOk).task.cronExpression).toBe('0 9 * * 1-5');
  });
});

describe('create-from-alignment', () => {
  function seedAlignment(sessionId: string, metadata?: Record<string, unknown>): void {
    const dir = join(dataDir, 'tasks', sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task.md'), '对齐稿', 'utf-8');
    if (metadata) writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata), 'utf-8');
  }

  it('非 once 被拒', async () => {
    const sessionId = 'align-session-1';
    seedAlignment(sessionId);
    const res = await handleTaskCreateFromAlignment({
      name: '排期任务',
      executor: 'agent',
      alignmentSessionId: sessionId,
      executionMode: 'recurring',
      workspaceId: 'ws-1',
      workspacePath,
    });
    expect(res.success).toBe(false);
    expect(errOf(res)).toMatch(/only supports executionMode=once/);
  });

  it('once：从 metadata 继承工作区，文档目录搬到新 id 名下', async () => {
    const sessionId = 'align-session-2';
    seedAlignment(sessionId, { workspaceId: 'ws-meta', workspacePath, sourceThoughtId: 'thought-1' });
    const res = await handleTaskCreateFromAlignment({
      name: '对齐任务',
      executor: 'agent',
      alignmentSessionId: sessionId,
      executionMode: 'once',
    });
    expect(res.success).toBe(true);
    const task = (res.data as CreateOk).task;
    expect(task.dispatchOrigin).toBe('ai-aligned');
    expect(task.workspaceId).toBe('ws-meta');
    expect(task.sourceThoughtId).toBe('thought-1');
    // 目录已搬到新任务名下，原对齐目录不再存在
    expect(existsSync(join(dataDir, 'tasks', String(task.id), 'task.md'))).toBe(true);
    expect(existsSync(join(dataDir, 'tasks', sessionId))).toBe(false);
  });

  it('对齐目录不存在 → 拒绝', async () => {
    const res = await handleTaskCreateFromAlignment({
      name: '无对齐目录',
      executor: 'agent',
      alignmentSessionId: 'align-missing',
      executionMode: 'once',
      workspaceId: 'ws',
      workspacePath,
    });
    expect(res.success).toBe(false);
    expect(errOf(res)).toMatch(/alignment dir not found/);
  });
});

describe('update', () => {
  it('成功：部分字段更新 + updatedAt 前移', async () => {
    const id = await createTask();
    const before = (await getTask(id)).updatedAt as number;
    const res = await handleTaskUpdate({ id, name: '改名了', tags: ['x'], intervalMinutes: 30 });
    expect(res.success).toBe(true);
    const task = (res.data as CreateOk).task;
    expect(task.name).toBe('改名了');
    expect(task.tags).toEqual(['x']);
    // once 模式的模式卫生：intervalMinutes 被清掉（与 Rust 同）
    expect(task.intervalMinutes).toBeUndefined();
    expect(task.updatedAt as number).toBeGreaterThanOrEqual(before);
    // 响应形状：task 带 docs（TaskWithDocs）
    expect((task.docs as Record<string, string>).taskMd).toBe(taskMdPath(id));
  });

  it('running / verifying 时拒绝（update_rejected_running）', async () => {
    const id = await createTask();
    await handleTaskUpdateStatus({ id, status: 'running' });
    const res = await handleTaskUpdate({ id, name: '改不动' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('update_rejected_running');
    // 未落盘
    expect((await getTask(id)).name).toBe('示例任务');
  });

  it('prompt 存在时原子写 task.md', async () => {
    const id = await createTask();
    const res = await handleTaskUpdate({ id, prompt: '新的执行说明' });
    expect(res.success).toBe(true);
    expect(readFileSync(taskMdPath(id), 'utf-8')).toBe('新的执行说明');
    // 空 prompt 被拒（Rust 同）
    const empty = await handleTaskUpdate({ id, prompt: '   ' });
    expect(empty.success).toBe(false);
    expect(errOf(empty)).toBe('prompt is empty');
  });

  it('未知 id → not_found 错误码', async () => {
    const res = await handleTaskUpdate({ id: 'no-such-task', name: 'x' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('not_found');
  });

  it('cron 表达式在 update 口校验（合并后、模式卫生之后）', async () => {
    const id = await createTask({ executionMode: 'recurring', intervalMinutes: 30 });
    const bad = await handleTaskUpdate({ id, cronExpression: 'not a cron' });
    expect(bad.success).toBe(false);
    expect(errOf(bad)).toContain('cron expression invalid');

    const ok = await handleTaskUpdate({ id, cronExpression: '0 */2 * * *' });
    expect(ok.success).toBe(true);
    expect((ok.data as CreateOk).task.cronExpression).toBe('0 */2 * * *');

    // executionMode 翻成 once 时 cron 被清掉 → 不该再为它报错
    const once = await handleTaskUpdate({ id, executionMode: 'once' });
    expect(once.success).toBe(true);
    expect((once.data as CreateOk).task.cronExpression).toBeUndefined();
  });
});

describe('update-status', () => {
  it('合法迁移：todo→running→done，写 history + lastExecutedAt', async () => {
    const id = await createTask();
    const running = await handleTaskUpdateStatus({ id, status: 'running' });
    expect(running.success).toBe(true);
    const runData = running.data as { task: Record<string, unknown>; transition: Record<string, unknown> };
    expect(runData.task.status).toBe('running');
    expect(runData.task.lastExecutedAt).toBeTypeOf('number');
    expect(runData.transition).toMatchObject({ from: 'todo', to: 'running', actor: 'user', source: 'cli' });

    const done = await handleTaskUpdateStatus({ id, status: 'done', message: '跑完了' });
    expect(done.success).toBe(true);
    const task = await getTask(id);
    expect(task.status).toBe('done');
    expect((task.statusHistory as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      from: 'running',
      to: 'done',
      message: '跑完了',
    });
    // 信任账本（宪章 §5.1）：进程内直接记账，不再绕 HTTP —— user 完成的
    // done 迁移应留下一条 +2 的存款。
    const ledger = readTrustLedger(10, dataDir);
    expect(ledger.events[0]).toMatchObject({ taskId: id, reason: 'user_done', delta: 2 });
  });

  it('非法迁移（todo→done）→ invalid_transition', async () => {
    const id = await createTask();
    const res = await handleTaskUpdateStatus({ id, status: 'done' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('invalid_transition');
    expect(errOf(res)).toContain('from todo to done');
    expect((await getTask(id)).status).toBe('todo');
  });

  it('目标 deleted → invalid_transition（deleted 只由 delete 写）', async () => {
    const id = await createTask();
    const res = await handleTaskUpdateStatus({ id, status: 'deleted', actor: 'user' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('invalid_transition');
    expect((await getTask(id)).deleted).toBe(false);
  });

  it('archived 仅 user：agent 归档 → archive_user_only', async () => {
    const id = await createTask();
    await handleTaskUpdateStatus({ id, status: 'running' });
    await handleTaskUpdateStatus({ id, status: 'done', actor: 'agent', source: 'cli' });
    const res = await handleTaskUpdateStatus({ id, status: 'archived', actor: 'agent', source: 'cli' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('archive_user_only');
    expect((await getTask(id)).status).toBe('done');
  });

  it('agent 必须 source=cli：source=ui → agent_source_must_be_cli', async () => {
    const id = await createTask();
    const res = await handleTaskUpdateStatus({ id, status: 'running', actor: 'agent', source: 'ui' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('agent_source_must_be_cli');
  });

  it('已软删的任务 → already_deleted', async () => {
    const id = await createTask();
    await handleTaskDelete({ id });
    const res = await handleTaskUpdateStatus({ id, status: 'running' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('already_deleted');
  });
});

describe('append-session', () => {
  it('去重追加（重复登记不新增、不 bump updatedAt）', async () => {
    const id = await createTask();
    const first = await handleTaskAppendSession({ id, sessionId: 'sess-1' });
    expect(first.success).toBe(true);
    const afterFirst = await getTask(id);
    expect(afterFirst.sessionIds).toEqual(['sess-1']);

    const again = await handleTaskAppendSession({ id, sessionId: 'sess-1' });
    expect(again.success).toBe(true);
    const afterSecond = await getTask(id);
    expect(afterSecond.sessionIds).toEqual(['sess-1']);
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);

    await handleTaskAppendSession({ id, sessionId: 'sess-2' });
    expect((await getTask(id)).sessionIds).toEqual(['sess-1', 'sess-2']);
  });
});

describe('archive', () => {
  it('done → archived（actor=user / source=ui）', async () => {
    const id = await createTask();
    await handleTaskUpdateStatus({ id, status: 'running' });
    await handleTaskUpdateStatus({ id, status: 'done' });
    const res = await handleTaskArchive({ id, message: '归档' });
    expect(res.success).toBe(true);
    expect((res.data as CreateOk).task.status).toBe('archived');
    const task = await getTask(id);
    expect((task.statusHistory as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      from: 'done',
      to: 'archived',
      actor: 'user',
      source: 'ui',
    });
  });

  it('非 done（todo）→ 非法迁移', async () => {
    const id = await createTask();
    const res = await handleTaskArchive({ id });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('invalid_transition');
  });
});

describe('delete', () => {
  it('软删：deleted/deletedAt/伪迁移 + 清 runs 文件 + 摘 runtime 条目', async () => {
    const id = await createTask();
    const store = createTaskStore();
    await store.appendRun(id, { ts: 1, ok: true, durationMs: 5 });
    await store.writeRuntime([
      { taskId: id, sessionId: 'sess-x', executionCount: 1, armed: true },
      { taskId: 'other-task', sessionId: 'sess-y', executionCount: 0, armed: false },
    ]);
    expect(existsSync(join(dataDir, 'task_runs', `${id}.jsonl`))).toBe(true);

    const res = await handleTaskDelete({ id });
    expect(res.success).toBe(true);

    const task = await getTask(id);
    expect(task.deleted).toBe(true);
    expect(task.status).toBe('deleted');
    expect(task.deletedAt).toBeTypeOf('number');
    expect((task.statusHistory as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      to: 'deleted',
      actor: 'user',
      message: 'deleted',
    });
    // 调度残留清理
    expect(existsSync(join(dataDir, 'task_runs', `${id}.jsonl`))).toBe(false);
    const runtime = await store.readRuntime();
    expect(runtime.map((e) => e.taskId)).toEqual(['other-task']);
    // 缺省列表里不再出现
    const list = await handleTaskList({});
    expect((list.data as unknown[]).length).toBe(0);
    expect((await handleTaskList({ includeDeleted: true })).data as unknown[]).toHaveLength(1);
  });

  it('幂等：重复 delete 不报错、不写第二条伪迁移（且从未跑过 = 无 runs 目录也不炸）', async () => {
    const id = await createTask();
    // 这条任务从没跑过：`task_runs/` 目录根本不存在。清理必须是 best-effort，
    // 不能因为"没有历史可删"就把已落盘的软删报成失败。
    const first = await handleTaskDelete({ id });
    expect(first.success).toBe(true);
    const historyAfterFirst = (await getTask(id)).statusHistory as unknown[];
    const again = await handleTaskDelete({ id });
    expect(again.success).toBe(true);
    expect((await getTask(id)).statusHistory as unknown[]).toHaveLength(historyAfterFirst.length);
  });

  it('未知 id → not_found', async () => {
    const res = await handleTaskDelete({ id: 'nope' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('not_found');
  });
});

describe('write-doc', () => {
  it('task / verify 可写（不存在则创建）', async () => {
    const id = await createTask();
    const verify = await handleTaskWriteDoc({ id, doc: 'verify', content: '# 验收' });
    expect(verify.success).toBe(true);
    expect(readFileSync(join(dataDir, 'tasks', id, 'verify.md'), 'utf-8')).toBe('# 验收');

    const task = await handleTaskWriteDoc({ id, doc: 'task', content: '改后的 task.md' });
    expect(task.success).toBe(true);
    expect(readFileSync(taskMdPath(id), 'utf-8')).toBe('改后的 task.md');
  });

  it('progress / alignment 被拒', async () => {
    const id = await createTask();
    for (const doc of ['progress', 'alignment']) {
      const res = await handleTaskWriteDoc({ id, doc, content: 'x' });
      expect(res.success).toBe(false);
      expect(errOf(res)).toContain('not writable via this API');
    }
    // 未知 doc 名
    const unknown = await handleTaskWriteDoc({ id, doc: 'secrets', content: 'x' });
    expect(unknown.success).toBe(false);
    expect(errOf(unknown)).toContain('unknown doc name');
  });

  it('running / verifying 时拒绝', async () => {
    const id = await createTask();
    await handleTaskUpdateStatus({ id, status: 'running' });
    const res = await handleTaskWriteDoc({ id, doc: 'task', content: 'x' });
    expect(res.success).toBe(false);
    expect(errOf(res)).toContain('update_rejected_running');
    expect(readFileSync(taskMdPath(id), 'utf-8')).toBe('执行任务：做事');
  });
});

describe('路径穿越 id 一律拒绝（所有写路由）', () => {
  const evil = '../../etc/passwd';
  it('create-from-alignment 的 alignmentSessionId / update / update-status / append-session / archive / delete / write-doc', async () => {
    const results = [
      await handleTaskCreateFromAlignment({
        name: 'x',
        executor: 'agent',
        alignmentSessionId: evil,
        executionMode: 'once',
        workspaceId: 'ws',
        workspacePath,
      }),
      await handleTaskUpdate({ id: evil, name: 'x' }),
      await handleTaskUpdateStatus({ id: evil, status: 'running' }),
      await handleTaskAppendSession({ id: evil, sessionId: 's' }),
      await handleTaskArchive({ id: evil }),
      await handleTaskDelete({ id: evil }),
      await handleTaskWriteDoc({ id: evil, doc: 'task', content: 'x' }),
    ];
    for (const res of results) {
      expect(res.success).toBe(false);
      expect(errOf(res)).toContain('taskId 非法');
    }
  });
});

/** 读一条任务（经 admin get，顺带验证读路径与写路径共用同一份落盘数据）。 */
async function getTask(id: string): Promise<Record<string, unknown>> {
  const res = await handleTaskGet({ id });
  expect(res.success).toBe(true);
  return res.data as Record<string, unknown>;
}
