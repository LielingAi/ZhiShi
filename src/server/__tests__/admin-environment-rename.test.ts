/**
 * 1.6.6 — environment/rename 接线测试（环境别名：只动 name，id 不改）。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）。
 * 覆盖：改名落盘 / 空名清除别名 / 未找到 id / 缺参。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleEnvironmentRename } from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

const ENTRY: EnvironmentEntry = {
  id: 'dev-box', kind: 'ssh', host: '10.10.0.5', user: 'root', createdAt: '2026-09-06T00:00:00Z',
};

function readEntries(): EnvironmentEntry[] {
  return (JSON.parse(readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8')) as {
    environments?: EnvironmentEntry[];
  }).environments ?? [];
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-rename-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  writeFileSync(join(scratch, '.zhishi', 'config.json'), JSON.stringify({ environments: [ENTRY] }), 'utf-8');
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentRename（1.6.6）', () => {
  it('改名落盘：name 更新，id/host 等身份字段不动', async () => {
    const r = await handleEnvironmentRename({ id: 'dev-box', name: '旧靶机' });
    expect(r.success).toBe(true);
    const e = readEntries()[0]!;
    expect(e.id).toBe('dev-box');
    expect(e.name).toBe('旧靶机');
    expect(e.host).toBe('10.10.0.5');
  });

  it('空名 → 清除别名（name 字段删除）', async () => {
    await handleEnvironmentRename({ id: 'dev-box', name: '临时名' });
    const r = await handleEnvironmentRename({ id: 'dev-box', name: '  ' });
    expect(r.success).toBe(true);
    expect(readEntries()[0]).not.toHaveProperty('name');
  });

  it('未找到 id → 失败且配置不动', async () => {
    const r = await handleEnvironmentRename({ id: 'ghost', name: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('ghost');
    expect(readEntries()[0]).not.toHaveProperty('name');
  });

  it('缺参：无 id / 无 name 字段 → 明确报错', async () => {
    const r1 = await handleEnvironmentRename({ name: 'x' });
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('<id>');
    const r2 = await handleEnvironmentRename({ id: 'dev-box' });
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('<name>');
  });
});
