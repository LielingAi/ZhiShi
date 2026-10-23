/**
 * 2.0.8 修：update-status 的 actor 推断。
 *
 * 事故：旧实现用 `process.env.ZHISHI_PORT ? 'agent' : 'user'` 判发起者，但这段
 * 代码跑在 sidecar 进程里、而 ZHISHI_PORT 正是 sidecar 自己写的 → 恒为真，
 * 每条 CLI 迁移都被记成 agent。信任账本 user_done(+2) / agent_done(+1) 因此
 * 记错档。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleTaskUpdateStatus } from '../admin-api';

let scratch: string;
let prevDataDir: string | undefined;
let prevPort: string | undefined;

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'actor 测试',
  executor: 'agent',
  workspaceId: '',
  workspacePath: '',
  executionMode: 'recurring',
  status: 'todo',
  tags: [],
  sessionIds: [],
  statusHistory: [],
  dispatchOrigin: 'direct',
  createdAt: 1,
  updatedAt: 1,
};

function readTask(): Record<string, unknown> {
  const raw = readFileSync(join(scratch, 'tasks.jsonl'), 'utf-8');
  return JSON.parse(raw.split('\n').filter(Boolean)[0]!);
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-actor-'));
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'tasks.jsonl'), `${JSON.stringify(ENTRY)}\n`, 'utf-8');
  prevDataDir = process.env.ZHISHI_DATA_DIR;
  prevPort = process.env.ZHISHI_PORT;
  process.env.ZHISHI_DATA_DIR = scratch;
  // 故意设上：旧实现会因此判成 agent。新实现必须无视它。
  process.env.ZHISHI_PORT = '59024';
});

afterEach(() => {
  // `process.env.X = undefined` 会把变量写成字符串 "undefined"（不是删除）——
  // 那样后续所有读 ZHISHI_DATA_DIR 的用例都会拿到相对路径 "undefined" 并失败。
  if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = prevDataDir;
  if (prevPort === undefined) delete process.env.ZHISHI_PORT;
  else process.env.ZHISHI_PORT = prevPort;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleTaskUpdateStatus 的 actor 缺省（2.0.8）', () => {
  it('sidecar 自带 ZHISHI_PORT 也按 user/cli 记 —— 不再被环境变量带偏', async () => {
    const r = await handleTaskUpdateStatus({ id: ENTRY.id, status: 'running' });
    expect(r.success).toBe(true);
    const t = readTask();
    const last = (t.statusHistory as Array<Record<string, unknown>>).at(-1)!;
    expect(last.actor).toBe('user');
    expect(last.source).toBe('cli');
  });

  it('调用方显式 stamp actor/source 时照用（将来 AI 工具/调度器靠这条）', async () => {
    const r = await handleTaskUpdateStatus({
      id: ENTRY.id, status: 'running', actor: 'system', source: 'scheduler',
    });
    expect(r.success).toBe(true);
    const last = (readTask().statusHistory as Array<Record<string, unknown>>).at(-1)!;
    expect(last.actor).toBe('system');
    expect(last.source).toBe('scheduler');
  });
});
