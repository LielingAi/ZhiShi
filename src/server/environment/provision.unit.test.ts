/**
 * provision.unit.test.ts — 1.4.9 已有环境补齐链路单测。
 *
 * 覆盖：脚本解析（VM→setup.sh / docker→provision.sh / 缺失报错）、sudo
 * 免密预检（不免密短路不进场）、base64 包装可还原、执行结果映射
 * （通道失败 / 非零退出 + 日志尾部 / 成功）。全部注入假 exec 与临时配方
 * 目录，零真实 IO 通道。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvironmentRecipe } from './recipes';
import {
  logTail,
  provisionEnvironment,
  provisionScriptCandidate,
  scriptNeedsSudo,
  wrapProvisionCommand,
  type ProvisionExecFn,
} from './provision';

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `zhishi-provision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENTRY: EnvironmentEntry = { id: 'pwn-vm', kind: 'vm', address: '192.168.1.10', createdAt: '' };

function recipe(id: string, base: 'docker' | 'vm'): EnvironmentRecipe {
  return { id, dir: join(dir, id), name: id, base, tools: [], valid: true, invalidReasons: [] };
}

function withFile(r: EnvironmentRecipe, name: string, content: string): EnvironmentRecipe {
  mkdirSync(r.dir, { recursive: true });
  writeFileSync(join(r.dir, name), content);
  return r;
}

/** 假 exec：按命令内容路由响应，记录调用。 */
function fakeExec(routes: Array<{ match: RegExp; res: { ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string } }>) {
  const calls: string[] = [];
  const exec: ProvisionExecFn = (_entry, command) => {
    calls.push(command.slice(0, 60));
    const hit = routes.find((r) => r.match.test(command));
    return Promise.resolve(hit?.res ?? { ok: true, exitCode: 0, stdout: '' });
  };
  return { exec, calls };
}

describe('纯函数 — 脚本解析 / 包装 / sudo 判定', () => {
  it('VM 配方 → setup.sh；docker 配方 → provision.sh', () => {
    expect(provisionScriptCandidate(recipe('pwn-vm', 'vm')).source).toBe('setup');
    expect(provisionScriptCandidate(recipe('code-audit', 'docker')).source).toBe('provision');
    expect(provisionScriptCandidate(recipe('code-audit', 'docker')).path).toContain('provision.sh');
  });

  it('scriptNeedsSudo：含 sudo 判定（注释里的 sudo 也算——预检多跑无害）', () => {
    expect(scriptNeedsSudo('apt-get install x')).toBe(false);
    expect(scriptNeedsSudo('sudo apt-get update\n')).toBe(true);
  });

  it('wrapProvisionCommand：base64 可还原（中文/多行/引号安全）', () => {
    const script = '#!/usr/bin/env bash\necho "你好 $(whoami)"\nsudo apt-get install -y gdb\n';
    const cmd = wrapProvisionCommand(script);
    expect(cmd).toContain('base64 -d | bash');
    const b64 = cmd.slice('echo '.length, cmd.indexOf(' | '));
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(script);
  });

  it('logTail：超长截尾保留尾部', () => {
    const long = 'x'.repeat(3000);
    expect(logTail(long)).toContain('前略');
    expect(logTail(long).length).toBeLessThan(2100);
    expect(logTail('short')).toBe('short');
  });
});

describe('provisionEnvironment（假 exec 通道）', () => {
  it('docker 配方有 provision.sh → 执行成功（无 sudo 脚本跳过预检）', async () => {
    const r = withFile(recipe('code-audit', 'docker'), 'provision.sh', 'echo install');
    const { exec, calls } = fakeExec([{ match: /base64 -d/, res: { ok: true, exitCode: 0, stdout: 'done' } }]);
    const out = await provisionEnvironment(ENTRY, r, { exec });
    expect(out.ok).toBe(true);
    expect(out.source).toBe('provision');
    expect(calls).toHaveLength(1); // 无 sudo → 不预检
  });

  it('docker 配方无 provision.sh → 明确报错（不碰 Dockerfile 提取）', async () => {
    const r = recipe('code-audit', 'docker');
    const { exec, calls } = fakeExec([]);
    const out = await provisionEnvironment(ENTRY, r, { exec });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('provision.sh');
    expect(calls).toHaveLength(0);
  });

  it('VM 配方缺 setup.sh → 明确报错', async () => {
    const out = await provisionEnvironment(ENTRY, recipe('pwn-vm', 'vm'), { exec: fakeExec([]).exec });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('setup.sh');
  });

  it('含 sudo 脚本：sudo -n 预检失败 → 不进场（主脚本未执行）', async () => {
    const r = withFile(recipe('pwn-vm', 'vm'), 'setup.sh', 'sudo apt-get install -y gdb');
    const { exec, calls } = fakeExec([{ match: /^sudo -n true/, res: { ok: true, exitCode: 1, stderr: 'password required' } }]);
    const out = await provisionEnvironment(ENTRY, r, { exec });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('免密 sudo');
    expect(calls).toHaveLength(1); // 只有预检，主脚本没跑
    expect(calls[0]).toContain('sudo -n true');
  });

  it('含 sudo 脚本：预检通过 → 主脚本执行', async () => {
    const r = withFile(recipe('pwn-vm', 'vm'), 'setup.sh', 'sudo apt-get install -y gdb');
    const { exec, calls } = fakeExec([{ match: /./, res: { ok: true, exitCode: 0, stdout: 'ok' } }]);
    const out = await provisionEnvironment(ENTRY, r, { exec });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('主脚本非零退出 → 失败 + 日志尾部带回', async () => {
    const r = withFile(recipe('pwn-vm', 'vm'), 'setup.sh', 'sudo apt-get install -y gdb');
    const { exec } = fakeExec([
      { match: /^sudo -n true/, res: { ok: true, exitCode: 0 } },
      { match: /base64 -d/, res: { ok: true, exitCode: 2, stdout: '', stderr: 'E: 无法定位软件包' } },
    ]);
    const out = await provisionEnvironment(ENTRY, r, { exec });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('退出码 2');
    expect(out.logTail).toContain('无法定位软件包');
  });

  it('通道失败（ok:false）→ 失败（环境问题不是脚本问题）', async () => {
    const r = withFile(recipe('code-audit', 'docker'), 'provision.sh', 'echo x');
    const { exec } = fakeExec([{ match: /./, res: { ok: false, error: 'ssh 不通' } }]);
    const out = await provisionEnvironment(ENTRY, r, { exec });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('ssh 不通');
  });
});
