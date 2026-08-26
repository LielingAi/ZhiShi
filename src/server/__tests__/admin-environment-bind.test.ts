/**
 * 1.3.8 多配方 — environment/bind-recipes 端点测试。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * 能力重推是 best-effort（探测失败静默），不阻塞绑定落盘。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleEnvironmentBindRecipes, __setCapabilityExecForTests } from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function readEntries(): EnvironmentEntry[] {
  const config = JSON.parse(readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8')) as {
    environments?: EnvironmentEntry[];
  };
  return config.environments ?? [];
}

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(join(scratch, '.zhishi', 'config.json'), JSON.stringify({ environments: entries }), 'utf-8');
}

const ENTRY: EnvironmentEntry = {
  id: 'pwn-vm',
  kind: 'vm',
  vmName: 'pwn-vm',
  recipeId: 'pwn-vm',
  createdAt: '2026-08-26T00:00:00Z',
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-bind-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  // best-effort 能力重推：注入失败探测（不真连 ssh，测试不挂 60s 超时）。
  __setCapabilityExecForTests(() => Promise.resolve({ ok: false }));
});

afterEach(() => {
  __setCapabilityExecForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentBindRecipes', () => {
  it('整体替换绑定集合并落盘（含主配方）', async () => {
    seedEntries([ENTRY]);
    const r = await handleEnvironmentBindRecipes({ id: 'pwn-vm', recipeIds: ['pwn-vm', 'pentest'] });
    expect(r.success).toBe(true);
    expect((r.data as { recipeIds: string[] }).recipeIds).toEqual(['pwn-vm', 'pentest']);
    expect(readEntries()[0].recipeIds).toEqual(['pwn-vm', 'pentest']);
  });

  it('主配方不在集合 → 拒绝且不落盘', async () => {
    seedEntries([ENTRY]);
    const r = await handleEnvironmentBindRecipes({ id: 'pwn-vm', recipeIds: ['pentest'] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('主配方');
    expect(readEntries()[0].recipeIds).toBeUndefined();
  });

  it('空数组 / 非数组 → 拒绝', async () => {
    seedEntries([ENTRY]);
    expect((await handleEnvironmentBindRecipes({ id: 'pwn-vm', recipeIds: [] })).success).toBe(false);
    expect((await handleEnvironmentBindRecipes({ id: 'pwn-vm', recipeIds: 'x' as unknown as string[] })).success).toBe(false);
    expect(readEntries()[0].recipeIds).toBeUndefined();
  });

  it('未知环境 → 拒绝', async () => {
    seedEntries([ENTRY]);
    const r = await handleEnvironmentBindRecipes({ id: 'nope', recipeIds: ['pwn-vm'] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未找到环境');
  });

  it('无主配方的条目：任意非空集合可绑定', async () => {
    const noPrimary: EnvironmentEntry = { id: 'ssh-1', kind: 'ssh', host: '10.0.0.9', createdAt: '2026-08-26T00:00:00Z' };
    seedEntries([noPrimary]);
    const r = await handleEnvironmentBindRecipes({ id: 'ssh-1', recipeIds: ['pentest', 'fuzz'] });
    expect(r.success).toBe(true);
    expect(readEntries()[0].recipeIds).toEqual(['pentest', 'fuzz']);
  });
});
