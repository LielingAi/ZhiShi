/**
 * M2 — boundary(loop/boundary.ts)unit tests.
 *
 * 每条规则的正反例 + evaluateBoundary 求值语义 + makeBoundaryHook 的
 * pi beforeToolCall 接线(block/reason 语义)。规则是纯函数,无 I/O。
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  buildDefaultBoundaryRules,
  credentialLeakRule,
  envReadyRule,
  evaluateBoundary,
  makeBoundaryHook,
  toolWhitelistRule,
  type BoundaryContext,
} from './boundary';

const VM_ENV: EnvironmentEntry = {
  id: 'pwn-vm',
  kind: 'vm',
  vmName: 'pwn-vm',
  address: '192.168.152.129',
  user: 'researcher',
  createdAt: '2026-01-01T00:00:00Z',
};

function ctx(partial: Partial<BoundaryContext>): BoundaryContext {
  return { toolName: 'env_exec', args: { command: 'id' }, env: VM_ENV, ...partial };
}

describe('tool-whitelist(结构性)', () => {
  const rule = toolWhitelistRule(['env_exec']);

  it('注册表内工具 → 通过', () => {
    expect(rule.check(ctx({}))).toBeUndefined();
  });

  it('注册表外工具 → deny(幻觉工具/宿主工具混入)', () => {
    expect(rule.check(ctx({ toolName: 'bash' }))).toContain('bash');
    expect(rule.check(ctx({ toolName: 'write_file' }))).toBeTruthy();
  });
});

describe('env-ready', () => {
  const rule = envReadyRule();

  it('已登记且可解析的环境 → 通过', () => {
    expect(rule.check(ctx({}))).toBeUndefined();
  });

  it('无 env 绑定 → deny「环境未就绪」', () => {
    const reason = rule.check(ctx({ env: null }));
    expect(reason).toContain('环境未就绪');
  });

  it('vm 缺 address → deny「环境未就绪」', () => {
    const reason = rule.check(ctx({ env: { ...VM_ENV, address: undefined } }));
    expect(reason).toContain('环境未就绪');
  });

  it('docker 条目(docker exec 通道已接通)→ 通过', () => {
    expect(rule.check(ctx({ env: { id: 'd', kind: 'docker', container: 'c', createdAt: '' } }))).toBeUndefined();
  });

  it('docker 缺 container(定位锚缺失)→ deny「环境未就绪」', () => {
    const reason = rule.check(ctx({ env: { id: 'd', kind: 'docker', createdAt: '' } }));
    expect(reason).toContain('环境未就绪');
  });

  it('断网 VM(guest 通道):有 passwordRef → 通过;无 → deny 带指引', () => {
    const base = { id: 'v', kind: 'vm' as const, vmName: 'iso', vmx: 'D:\\v\\iso.vmx', createdAt: '' };
    expect(rule.check(ctx({ env: { ...base, passwordRef: 'env:ZHISHI_VM_PW' } }))).toBeUndefined();
    const reason = rule.check(ctx({ env: base }));
    expect(reason).toContain('passwordRef');
  });

  it('非 env_exec 工具不适用本规则', () => {
    expect(rule.check(ctx({ toolName: 'other', env: null }))).toBeUndefined();
  });

  it('env_bg(后台进程)同环境绑定:docker 条目通过;无 env deny', () => {
    expect(rule.check(ctx({ toolName: 'env_bg', env: { id: 'd', kind: 'docker', container: 'c', createdAt: '' } }))).toBeUndefined();
    expect(rule.check(ctx({ toolName: 'env_bg', env: null }))).toContain('环境未就绪');
  });
});

describe('credential-leak(D14)', () => {
  const rule = credentialLeakRule();

  it('普通命令 → 通过', () => {
    expect(rule.check(ctx({ args: { command: 'uname -a && gdb --version' } }))).toBeUndefined();
    expect(rule.check(ctx({ args: { command: 'cat /etc/passwd' } }))).toBeUndefined();
  });

  it.each([
    ['type C:\\Users\\Administrator\\.ssh\\id_ed25519', 'Windows 用户目录'],
    ['cat ~/.zhishi/config.json', '~/.zhishi'],
    ['echo -----BEGIN OPENSSH PRIVATE KEY-----', '私钥内容头'],
    ['cat config.json | grep providerApiKeys', 'providerApiKeys'],
  ])('命中敏感材料 → deny: %s', (command) => {
    const reason = rule.check(ctx({ args: { command } }));
    expect(reason).toBeTruthy();
    expect(reason).toContain('D14');
  });

  it('env_bg start 的 command 同受凭据纪律约束', () => {
    expect(rule.check(ctx({ toolName: 'env_bg', args: { command: 'cat ~/.zhishi/config.json' } }))).toContain('D14');
    expect(rule.check(ctx({ toolName: 'env_bg', args: { command: 'uname -a' } }))).toBeUndefined();
  });

  it('command 非字符串(异常 args)→ 不误杀', () => {
    expect(rule.check(ctx({ args: {} }))).toBeUndefined();
    expect(rule.check(ctx({ args: undefined }))).toBeUndefined();
  });

  it('非 env_exec 工具不适用本规则', () => {
    expect(rule.check(ctx({ toolName: 'other', args: { command: 'cat ~/.zhishi/x' } }))).toBeUndefined();
  });
});

describe('evaluateBoundary', () => {
  const rules = buildDefaultBoundaryRules();

  it('全过 → allow', () => {
    expect(evaluateBoundary(ctx({}), rules)).toEqual({ decision: 'allow' });
  });

  it('首个 deny 胜出,reason 带规则名前缀', () => {
    const d = evaluateBoundary(ctx({ toolName: 'bash' }), rules);
    expect(d.decision).toBe('deny');
    if (d.decision === 'deny') expect(d.reason).toContain('[boundary:tool-whitelist]');
  });

  it('凭据泄漏命中第三条', () => {
    const d = evaluateBoundary(ctx({ args: { command: 'cat ~/.zhishi/config.json' } }), rules);
    expect(d.decision).toBe('deny');
    if (d.decision === 'deny') expect(d.reason).toContain('[boundary:credential-leak]');
  });
});

describe('makeBoundaryHook(pi beforeToolCall 接线)', () => {
  const hook = makeBoundaryHook(VM_ENV);

  function piCtx(toolName: string, args: unknown) {
    return { toolCall: { type: 'toolCall', id: 't1', name: toolName, arguments: {} }, args } as never;
  }

  it('allow → undefined(放行)', async () => {
    expect(await hook(piCtx('env_exec', { command: 'hostname' }))).toBeUndefined();
  });

  it('deny → { block:true, reason }(pi 回注模型)', async () => {
    const r = await hook(piCtx('env_exec', { command: 'cat ~/.zhishi/config.json' }));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain('credential-leak');
  });

  it('白名单外工具 → block', async () => {
    const r = await hook(piCtx('bash', { command: 'id' }));
    expect(r?.block).toBe(true);
  });

  it('未绑定环境 → block「环境未就绪」', async () => {
    const noEnvHook = makeBoundaryHook(null);
    const r = await noEnvHook(piCtx('env_exec', { command: 'id' }));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain('环境未就绪');
  });

  it('规则异常按 deny 处理(硬闸宁可错杀)', async () => {
    const badHook = makeBoundaryHook(VM_ENV, {
      rules: [{ name: 'boom', check: () => { throw new Error('rule bug'); } }],
    });
    const r = await badHook(piCtx('env_exec', { command: 'id' }));
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain('[boundary:internal]');
  });

  it('自定义 allowedTools 生效', async () => {
    const wideHook = makeBoundaryHook(VM_ENV, { allowedTools: ['env_exec', 'read_file'] });
    expect(await wideHook(piCtx('read_file', {}))).toBeUndefined();
  });
});
