/**
 * 2.0.6 — environment/set 接线测试（条目字段部分更新）。
 *
 * 背景：environment/add 只增不改、也没有 update 路由——vm 模板带出的 keyPath
 * 摘不掉，而 ssh 通道密钥优先，只认密码的设备（防火墙/网络设备）会永远
 * 走不通。本路由是唯一的纠正入口。
 *
 * 配置注入照 admin-environment-rename 测试惯例（临时 HOME + config.json 播种）。
 * 覆盖：清 keyPath / 设 passwordRef 落盘 / 空参只读回显 / 未找到 id /
 * 不支持的 clear 字段 / 非法 osFamily / ssh 凭据二选一 / 端口数字收敛 /
 * 其余字段（vmx/配方/createdAt）原样保留。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleEnvironmentSet } from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

/** Junos 防火墙实机形状：vm 条目带模板 keyPath，没有 passwordRef。 */
const VM_ENTRY: EnvironmentEntry = {
  id: 'vsrx3-133',
  kind: 'vm',
  name: 'vsrx3-133',
  user: 'root',
  osFamily: 'linux',
  vmName: 'vsrx3-133',
  address: '192.168.88.133',
  vmx: 'E:\\vms\\vsrx3-133.vmx',
  keyPath: 'C:\\Users\\wren\\.zhishi\\keys\\zhishi_vm_ed25519',
  recipeIds: ['dev'],
  recipeId: 'dev',
  createdAt: '2026-10-20T08:12:17.397Z',
};

const SSH_ENTRY: EnvironmentEntry = {
  id: 'fw-ssh', kind: 'ssh', host: '10.0.0.9', user: 'admin', createdAt: '2026-10-20T00:00:00Z',
};

function readEntries(): EnvironmentEntry[] {
  return (JSON.parse(readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8')) as {
    environments?: EnvironmentEntry[];
  }).environments ?? [];
}

function seed(entries: EnvironmentEntry[]): void {
  writeFileSync(join(scratch, '.zhishi', 'config.json'), JSON.stringify({ environments: entries }), 'utf-8');
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-set-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  seed([VM_ENTRY, SSH_ENTRY]);
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

describe('handleEnvironmentSet（2.0.6）', () => {
  it('清 keyPath + 设 passwordRef：落盘，vm 锚与配方字段不动', async () => {
    const r = await handleEnvironmentSet({
      id: 'vsrx3-133', clear: 'key-path', passwordRef: 'env:VSRX_ROOT_PW',
    });
    expect(r.success).toBe(true);
    const e = readEntries().find((x) => x.id === 'vsrx3-133')!;
    expect(e).not.toHaveProperty('keyPath');
    expect(e.passwordRef).toBe('env:VSRX_ROOT_PW');
    // 修条目不等于重登：其余字段原样保留
    expect(e.vmx).toBe('E:\\vms\\vsrx3-133.vmx');
    expect(e.vmName).toBe('vsrx3-133');
    expect(e.address).toBe('192.168.88.133');
    expect(e.recipeId).toBe('dev');
    expect(e.createdAt).toBe('2026-10-20T08:12:17.397Z');
  });

  it('不带参数 = 只读回显（不改配置文件）', async () => {
    const before = readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8');
    const r = await handleEnvironmentSet({ id: 'vsrx3-133' });
    expect(r.success).toBe(true);
    const data = r.data as { entry?: EnvironmentEntry; changed?: boolean };
    expect(data.changed).toBe(false);
    expect(data.entry?.keyPath).toContain('zhishi_vm_ed25519');
    expect(readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8')).toBe(before);
  });

  it('空串同样清除字段', async () => {
    const r = await handleEnvironmentSet({ id: 'vsrx3-133', keyPath: '' });
    expect(r.success).toBe(true);
    expect(readEntries().find((x) => x.id === 'vsrx3-133')).not.toHaveProperty('keyPath');
  });

  it('ssh 条目凭据二选一：同时给 keyPath 与 passwordRef → 拒绝且不落盘', async () => {
    seed([SSH_ENTRY]);
    const r = await handleEnvironmentSet({
      id: 'fw-ssh', keyPath: '~/.ssh/id_ed25519', passwordRef: 'env:FW_PW',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('passwordRef');
    const e = readEntries().find((x) => x.id === 'fw-ssh')!;
    expect(e).not.toHaveProperty('keyPath');
    expect(e).not.toHaveProperty('passwordRef');
  });

  it('未找到 id / 缺 id → 明确报错', async () => {
    const ghost = await handleEnvironmentSet({ id: 'ghost', user: 'x' });
    expect(ghost.success).toBe(false);
    if (!ghost.success) expect(ghost.error).toContain('ghost');
    const noId = await handleEnvironmentSet({ user: 'x' });
    expect(noId.success).toBe(false);
    if (!noId.success) expect(noId.error).toContain('<id>');
  });

  it('clear 不支持的字段 / osFamily 非法 → 明确报错', async () => {
    const badField = await handleEnvironmentSet({ id: 'vsrx3-133', clear: 'password' });
    expect(badField.success).toBe(false);
    if (!badField.success) expect(badField.error).toContain('--clear');
    const badFamily = await handleEnvironmentSet({ id: 'vsrx3-133', osFamily: 'junos' });
    expect(badFamily.success).toBe(false);
    if (!badFamily.success) expect(badFamily.error).toContain('osFamily');
  });

  it('端口字符串收成数字', async () => {
    seed([SSH_ENTRY]);
    const r = await handleEnvironmentSet({ id: 'fw-ssh', port: '2222' });
    expect(r.success).toBe(true);
    expect(readEntries().find((x) => x.id === 'fw-ssh')?.port).toBe(2222);
  });
});
