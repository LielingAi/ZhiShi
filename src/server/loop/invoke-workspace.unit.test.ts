/**
 * S6 ① — per-invoke workspace 的 characterization 测试。
 *
 * 锁两件事：
 *   1. `resolveInvokeWorkspace`：未传 / 空串 → 引擎 agentDir（交互线与老调用方
 *      **逐字节不变**）；传了 → 用它。
 *   2. `resolveInvokeLineEnvFor`：同一个 loop 线，在不同工作区下解析出**不同**的
 *      环境锚 —— 这正是 S5 报告的 bug（任务在 A、sidecar 起在 B → env_exec 挂到
 *      B 的环境上，占用登记也错，且不报错）。
 *
 * 不真跑 turn：`invokePiSession` 要 provider + LLM。这里测的是它内部那条解析链
 * 的纯函数版本（原 `ChatEngine#resolveInvokeLineEnv`），wiring 由调用点保证。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { envSessionLineKey } from '../environment/env-sessions';
import { resolveInvokeLineEnvFor, resolveInvokeWorkspace, resolveSessionEnv } from '../loop/chat-engine';

const ORIGINAL_DATA_DIR = process.env.ZHISHI_DATA_DIR;

let root: string;
let workspaceA: string;
let workspaceB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhishi-invoke-ws-'));
  workspaceA = join(root, 'ws-a');
  workspaceB = join(root, 'ws-b');
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  process.env.ZHISHI_DATA_DIR = join(root, 'data');
  mkdirSync(process.env.ZHISHI_DATA_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = ORIGINAL_DATA_DIR;
});

/** 写工作区环境选定（`<dataDir>/env-selection.json`）。 */
function seedSelection(workspace: string, envId: string): void {
  const path = join(process.env.ZHISHI_DATA_DIR!, 'env-selection.json');
  let store: { version: 1; workspaces: Record<string, unknown> } = { version: 1, workspaces: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as typeof store;
    if (raw && raw.workspaces) store = raw;
  } catch {
    // 首次
  }
  store.workspaces[workspace] = {
    selection: { kind: 'env', id: envId },
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(store), 'utf-8');
}

/** 写一条 env-sessions 映射行（`<dataDir>/env-sessions.json`）。 */
function seedEnvSessionLine(
  workspace: string,
  envKey: string,
  loopSessionId: string,
  segment?: string
): void {
  const path = join(process.env.ZHISHI_DATA_DIR!, 'env-sessions.json');
  let map: { version: 1; lines: Record<string, unknown> } = { version: 1, lines: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as typeof map;
    if (raw && raw.lines) map = raw;
  } catch {
    // 首次
  }
  map.lines[envSessionLineKey(workspace, envKey, segment)] = {
    loopSessionId,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(map), 'utf-8');
}

describe('resolveInvokeWorkspace（per-invoke 工作区选择）', () => {
  it('未传 → 引擎 agentDir（characterization：交互线与老调用方逐字节不变）', () => {
    expect(resolveInvokeWorkspace(undefined, workspaceA)).toBe(workspaceA);
  });

  it('空串 / 纯空白 → 回落 agentDir', () => {
    expect(resolveInvokeWorkspace('', workspaceA)).toBe(workspaceA);
    expect(resolveInvokeWorkspace('   ', workspaceA)).toBe(workspaceA);
  });

  it('传了 → trim 后用它（cron 传任务工作区）', () => {
    expect(resolveInvokeWorkspace(workspaceB, workspaceA)).toBe(workspaceB);
    expect(resolveInvokeWorkspace(`  ${workspaceB}  `, workspaceA)).toBe(workspaceB);
  });
});

describe('resolveInvokeLineEnvFor（环境锚按 invoke 工作区解析）', () => {
  it('工作区选定差异 → 同一个 loop 线解析出不同环境（S5 bug 的根）', () => {
    // A 选了内置 local 环境；B 没选（host → 不注册执行工具）
    seedSelection(workspaceA, 'local');

    const envForA = resolveInvokeLineEnvFor(workspaceA, 'line-1');
    const envForB = resolveInvokeLineEnvFor(workspaceB, 'line-1');

    expect(envForA?.id).toBe('local');
    expect(envForB).toBeNull();
    // 旧行为（用引擎启动工作区 B 去解析）＝ 拿不到环境 → env_exec 缺失
    expect(resolveSessionEnv(workspaceB)).toBeNull();
  });

  it('env-sessions 映射优先于工作区选定（线锚不被工作区选定顶掉）', () => {
    // A 的工作区选定是 local，但这条线明确挂在另一个环境键上（映射即线锚）
    seedSelection(workspaceA, 'host' as never);
    seedEnvSessionLine(workspaceA, 'env:local', 'line-2');

    const resolved = resolveInvokeLineEnvFor(workspaceA, 'line-2');
    expect(resolved?.id).toBe('local');
  });

  it('映射只对**同一个工作区**生效：换工作区就回落该工作区的选定', () => {
    seedSelection(workspaceA, 'local');
    seedEnvSessionLine(workspaceA, 'env:local', 'line-3');

    expect(resolveInvokeLineEnvFor(workspaceA, 'line-3')?.id).toBe('local');
    // 同一条线 id、不同工作区 → 映射不命中（前缀不同），回落 B 的选定 = 无
    expect(resolveInvokeLineEnvFor(workspaceB, 'line-3')).toBeNull();
  });

  it('无 loopSessionId → 直接按工作区选定（characterization）', () => {
    seedSelection(workspaceA, 'local');
    expect(resolveInvokeLineEnvFor(workspaceA)?.id).toBe('local');
    expect(resolveInvokeLineEnvFor(workspaceB)).toBeNull();
  });
});
