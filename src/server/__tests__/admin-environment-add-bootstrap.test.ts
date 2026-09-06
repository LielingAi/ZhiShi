/**
 * 1.6.5 — environment/add 密钥引导分支接线测试。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * 密钥引导走 __setKeyBootstrapForTests 假通道（绝不真连目标），能力探测
 * 走 __setCapabilityExecForTests 假失败（探测是锦上添花，与引导正交）。
 *
 * 覆盖：
 *  - ssh 条目缺 keyPath + 带瞬传 password → 引导成功，生成的 keyPath 落条目，
 *    密码不进 config.json（D-T4 核查）；
 *  - 引导失败 → 整体不登记（不留半成品条目）；
 *  - keyPath 与密码同给 → 明确报错（矛盾输入）；
 *  - password 字段不带/为空 → 旧路径零变化（registry 纯校验，无引导调用）；
 *  - 引导被调用时收到正确的 target 形状（kind/host/user/osFamily 透传）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __setCapabilityExecForTests,
  __setKeyBootstrapForTests,
  handleEnvironmentAdd,
} from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';
import type { KeyBootstrapTarget } from '../environment/key-bootstrap';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function readConfigRaw(): string {
  return readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8');
}

function readEntries(): EnvironmentEntry[] {
  return (JSON.parse(readConfigRaw()) as { environments?: EnvironmentEntry[] }).environments ?? [];
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-add-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  writeFileSync(join(scratch, '.zhishi', 'config.json'), JSON.stringify({ environments: [] }), 'utf-8');
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  // 探测通道假失败（probe 失败静默，不影响登记断言）
  __setCapabilityExecForTests(() => Promise.resolve({ ok: false }));
});

afterEach(() => {
  __setKeyBootstrapForTests(null);
  __setCapabilityExecForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentAdd — 密钥引导（1.6.5）', () => {
  it('ssh 条目缺 keyPath + password → 引导成功，keyPath 落条目，密码不进 config.json', async () => {
    let seenTarget: KeyBootstrapTarget | undefined;
    let seenPassword = '';
    __setKeyBootstrapForTests((target, password) => {
      seenTarget = target;
      seenPassword = password;
      return Promise.resolve({ ok: true, keyPath: 'C:\\keys\\zhishi_vm_ed25519', via: 'plink' });
    });
    const r = await handleEnvironmentAdd({
      id: 'range-1', kind: 'ssh', host: '10.10.0.5', user: 'root', password: 's3cret',
    });
    expect(r.success).toBe(true);
    // 引导收到的 target 形状与瞬传密码
    expect(seenTarget).toMatchObject({ kind: 'ssh', host: '10.10.0.5', user: 'root', osFamily: 'linux' });
    expect(seenPassword).toBe('s3cret');
    // 条目落了生成的 keyPath
    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.keyPath).toBe('C:\\keys\\zhishi_vm_ed25519');
    // D-T4 核查：密码全文不出现在 config.json
    expect(readConfigRaw()).not.toContain('s3cret');
    expect(readConfigRaw()).not.toContain('"password"');
  });

  it('引导失败 → 整体不登记（config 无条目）', async () => {
    __setKeyBootstrapForTests(() => Promise.resolve({ ok: false, error: '公钥推送失败（密码不对）' }));
    const r = await handleEnvironmentAdd({
      id: 'range-1', kind: 'ssh', host: '10.10.0.5', user: 'root', password: 'wrong',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('密钥引导失败');
    expect(r.error).toContain('密码不对');
    expect(readEntries()).toEqual([]);
  });

  it('keyPath 与密码同给 → 矛盾输入报错，不登记', async () => {
    let called = 0;
    __setKeyBootstrapForTests(() => { called += 1; return Promise.resolve({ ok: true, keyPath: '/k', via: 'plink' }); });
    const r = await handleEnvironmentAdd({
      id: 'range-1', kind: 'ssh', host: '10.10.0.5', user: 'root', keyPath: '/home/me/.ssh/id', password: 'x',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('同时给了 keyPath 和密码');
    expect(called).toBe(0);
    expect(readEntries()).toEqual([]);
  });

  it('不带 password → 旧路径零变化（无 keyPath 也照常登记，不触发引导）', async () => {
    let called = 0;
    __setKeyBootstrapForTests(() => { called += 1; return Promise.resolve({ ok: true, keyPath: '/k', via: 'plink' }); });
    const r = await handleEnvironmentAdd({ id: 'range-1', kind: 'ssh', host: '10.10.0.5', user: 'root' });
    expect(r.success).toBe(true);
    expect(called).toBe(0);
    expect(readEntries()[0]!.keyPath).toBeUndefined();
  });

  it('docker 条目带 password → 不触发引导（docker 无凭据语义）', async () => {
    let called = 0;
    __setKeyBootstrapForTests(() => { called += 1; return Promise.resolve({ ok: true, keyPath: '/k', via: 'plink' }); });
    const r = await handleEnvironmentAdd({ id: 'd1', kind: 'docker', container: 'c1', password: 'x' });
    expect(r.success).toBe(true);
    expect(called).toBe(0);
  });
});
