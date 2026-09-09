/**
 * 1.6.7 R3 — environment/select 探活接线测试。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi 播种）；探活走
 * __setSelectProbeForTests 假通道，绝不真连目标。引擎侧 envSwitchBlocker /
 * switchEnvSession 对非本引擎 workspace 是 no-op（agentDir 不匹配）——
 * 测试 workspace 用任意临时路径即天然安全。
 *
 * 覆盖：SSH 通道条目探活失败 → 拒绝且不落盘（含鉴权引导文案）；探活通过 →
 * 正常选定；断网 VM（无 address）/ docker 条目 / host 选定不探（各零调用）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __setSelectProbeForTests, handleEnvironmentSelect } from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let workspace: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

const SSH_ENTRY: EnvironmentEntry = {
  id: 'range-1', kind: 'ssh', host: '10.10.0.5', user: 'root', createdAt: '2026-09-09T00:00:00Z',
};
const OFFLINE_VM: EnvironmentEntry = {
  id: 'det-win', kind: 'vm', vmName: 'det-win', vmx: 'C:\\VMs\\det-win\\det-win.vmx', osFamily: 'windows', createdAt: '2026-09-09T00:00:00Z',
};
const DOCKER_ENTRY: EnvironmentEntry = {
  id: 'zhishi-pwn-a3f2', kind: 'docker', container: 'zhishi-pwn-a3f2', createdAt: '2026-09-09T00:00:00Z',
};

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(join(scratch, '.zhishi', 'config.json'), JSON.stringify({ environments: entries }), 'utf-8');
}

function selectionPersisted(): boolean {
  const raw = readFileSync(join(scratch, '.zhishi', 'env-selection.json'), 'utf-8');
  return Object.keys(JSON.parse(raw) as Record<string, unknown>).length > 0;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-select-'));
  workspace = join(scratch, 'ws');
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  writeFileSync(join(scratch, '.zhishi', 'env-selection.json'), '{}', 'utf-8');
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  __setSelectProbeForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentSelect — R3 探活', () => {
  it('SSH 条目探活失败（鉴权）→ 拒绝选定、不落盘、文案带密码引导', async () => {
    seedEntries([SSH_ENTRY]);
    __setSelectProbeForTests(() => Promise.resolve({ ok: false, error: 'Permission denied (publickey,password)' }));
    const r = await handleEnvironmentSelect({
      workspace, selection: { kind: 'env', id: 'range-1' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('探活失败');
    expect(r.error).toContain('密码引导');
    expect(selectionPersisted()).toBe(false);
  });

  it('SSH 条目探活通过 → 正常选定落盘', async () => {
    seedEntries([SSH_ENTRY]);
    __setSelectProbeForTests(() => Promise.resolve({ ok: true }));
    const r = await handleEnvironmentSelect({
      workspace, selection: { kind: 'env', id: 'range-1' },
    });
    expect(r.success).toBe(true);
    expect(selectionPersisted()).toBe(true);
  });

  it('断网 VM（无 address）/ docker / host → 不探（探活零调用）', async () => {
    seedEntries([OFFLINE_VM, DOCKER_ENTRY]);
    let calls = 0;
    __setSelectProbeForTests(() => { calls += 1; return Promise.resolve({ ok: true }); });
    const r1 = await handleEnvironmentSelect({ workspace, selection: { kind: 'env', id: 'det-win' } });
    expect(r1.success).toBe(true);
    const r2 = await handleEnvironmentSelect({ workspace, selection: { kind: 'env', id: 'zhishi-pwn-a3f2' } });
    expect(r2.success).toBe(true);
    const r3 = await handleEnvironmentSelect({ workspace, selection: { kind: 'host' } });
    expect(r3.success).toBe(true);
    expect(calls).toBe(0);
  });
});
