/**
 * 1.7.8 — local（本机）条目的 down/rm 守卫接线测试（unit 快池）。
 *
 * 验收补口：down 对 local 曾穿过 ssh/vm 分支落到 routeVmTarget 全 false →
 * docker 兜底报噪声错误；rm 对物化副本曾落到「只摘登记」把探测产物删掉。
 * 守卫照 ssh 的 B12 先例加在实体/引擎探测前——本文件断言拒绝文案、
 * 「不碰探测」（docker probe 计数 = 0）与「探测产物不丢」（config 原样）。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * docker 运行探测走 __setRmDockerProbeForTests 假通道——绝不真调
 * docker/hyperv/vbox/vmrun。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __setRmDockerOpsForTests,
  __setRmDockerProbeForTests,
  handleEnvironmentBindRecipes,
  handleEnvironmentDown,
  handleEnvironmentRm,
} from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function readConfig(): { environments?: EnvironmentEntry[] } {
  return JSON.parse(readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8')) as {
    environments?: EnvironmentEntry[];
  };
}

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(
    join(scratch, '.zhishi', 'config.json'),
    JSON.stringify({ environments: entries }),
    'utf-8',
  );
}

const SSH_ENTRY: EnvironmentEntry = {
  id: 'range-1',
  kind: 'ssh',
  host: '10.10.0.5',
  user: 'root',
  createdAt: '2026-08-25T00:00:00Z',
};

/** 物化副本形态：capability-refresh 落盘后的 kind=local 条目。 */
const MATERIALIZED_LOCAL: EnvironmentEntry = {
  id: 'local',
  kind: 'local',
  osFamily: 'windows',
  createdAt: '',
  localToolchain: { present: ['msvc'], missing: ['windbg'], checkedAt: '2026-09-20T00:00:00Z' },
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-local-guards-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  __setRmDockerProbeForTests(null);
  __setRmDockerOpsForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentBindRecipes — 1.7.9 local 守卫（本机能力面 = 实机探测）', () => {
  it('虚拟内置条目 → 拒绝（不支持绑定配方），不落「未找到环境」误导错误', async () => {
    seedEntries([]);
    const r = await handleEnvironmentBindRecipes({ id: 'local', recipeIds: ['pwn'] });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不支持绑定配方/);
  });

  it('物化副本 → 同一拒绝；绑定集合不被改写', async () => {
    seedEntries([MATERIALIZED_LOCAL]);
    const r = await handleEnvironmentBindRecipes({ id: 'local', recipeIds: ['pwn'] });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不支持绑定配方/);
    expect(readConfig().environments?.[0].recipeIds).toBeUndefined();
  });
});

describe('handleEnvironmentDown — 1.7.8 local 守卫（B12 同款）', () => {
  it('虚拟内置条目（config 无 local）→ 「本机环境无实体可停」，不落 docker 兜底', async () => {
    seedEntries([]);
    const r = await handleEnvironmentDown({ id: 'local' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('本机环境');
    expect(r.error).toContain('无实体可停');
  });

  it('物化副本 → 同一拒绝；守卫在引擎探测前（不碰任何实体探测通道）', async () => {
    seedEntries([MATERIALIZED_LOCAL]);
    const r = await handleEnvironmentDown({ id: 'local' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('本机环境');
    expect(r.error).toContain('无实体可停');
    // config 原样（down 本就不该写盘，防御性断言）。
    expect(readConfig().environments).toHaveLength(1);
  });
});

describe('handleEnvironmentRm — 1.7.8 local 守卫（不可删除）', () => {
  it('虚拟内置条目 → 拒绝（不可删除 + capability-refresh 指引）；登记不动、不碰实体探测', async () => {
    seedEntries([SSH_ENTRY]);
    let probeCalled = 0;
    __setRmDockerProbeForTests(() => {
      probeCalled += 1;
      return Promise.resolve({ ok: true, running: false });
    });
    const r = await handleEnvironmentRm({ id: 'local' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('不可删除');
    expect(r.error).toContain('capability-refresh');
    expect((readConfig().environments ?? []).map((e) => e.id)).toEqual(['range-1']);
    expect(probeCalled).toBe(0); // 守卫在 docker 探测之前
  });

  it('物化副本 → 同一拒绝；条目保留、探测产物（localToolchain）不丢', async () => {
    seedEntries([SSH_ENTRY, MATERIALIZED_LOCAL]);
    const r = await handleEnvironmentRm({ id: 'local' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('不可删除');
    const config = readConfig();
    const local = (config.environments ?? []).find((e) => e.id === 'local');
    expect(local).toBeTruthy(); // 未被摘登记
    expect(local!.localToolchain?.present).toEqual(['msvc']); // 探测产物不丢
  });
});
