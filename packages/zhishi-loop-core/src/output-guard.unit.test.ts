/**
 * M3 — output-guard(loop/output-guard.ts)unit tests.
 *
 * 命中净化(私钥头/apiKey 形态/宿主路径)、未命中透传、多命中审计、
 * afterToolCall 接线(content 覆盖语义、[redacted] 模型可见)、规则异常
 * 按净化处理。纯函数,无 I/O。
 */
import { describe, expect, it } from 'vitest';

import {
  credentialEchoRule,
  evaluateOutputGuard,
  makeOutputGuardHook,
} from './output-guard';

const CTX = { toolName: 'env_exec', isError: false };
const RULES = [credentialEchoRule()];

function afterCtx(text: string) {
  return {
    toolCall: { type: 'toolCall', id: 't1', name: 'env_exec', arguments: {} },
    result: { content: [{ type: 'text', text }], details: { exitCode: 0 } },
    isError: false,
  } as never;
}

describe('credential-echo 规则', () => {
  it.each([
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----', '私钥头'],
    ['token=sk-abcdefghijklmnop1234', 'sk- 形态'],
    ['"apiKey": "abcd1234abcd1234abcd1234"', 'key 赋值形态'],
    ['file written to ~/.zhishi/memory/x.md', '~/.zhishi'],
    ['see C:\\Users\\Administrator\\config', '宿主用户目录'],
    ['{"providerApiKeys":{}}', 'providerApiKeys'],
  ])('命中 → 净化: %s', (text) => {
    const r = evaluateOutputGuard(text, CTX, RULES);
    expect(r.redacted).toBe(true);
    expect(r.text).toContain('[redacted');
    expect(r.text).not.toContain(text.slice(0, 20));
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it.each([
    'Linux fuzz 7.0.0-28-generic x86_64 GNU/Linux',
    'gcc (Ubuntu 13.2.0) 13.2.0',
    'total 48\ndrwxr-xr-x 2 researcher researcher 4096',
  ])('未命中 → 透传: %s', (text) => {
    const r = evaluateOutputGuard(text, CTX, RULES);
    expect(r.redacted).toBe(false);
    expect(r.text).toBe(text);
    expect(r.reasons).toEqual([]);
  });

  it('多命中:审计 reasons 收集全部命中规则', () => {
    const r = evaluateOutputGuard('cat ~/.zhishi/key -----BEGIN PRIVATE KEY-----', CTX, RULES);
    expect(r.redacted).toBe(true);
    // 同一规则命中首个模式即返,但 reasons 记录规则名与标签
    expect(r.reasons[0]).toContain('[guard:credential-echo]');
  });
});

describe('makeOutputGuardHook(afterToolCall 接线)', () => {
  const hook = makeOutputGuardHook();

  it('命中 → 返回 content 覆盖,文本为 [redacted](模型可见)', async () => {
    const r = await hook(afterCtx('-----BEGIN OPENSSH PRIVATE KEY-----\nxyz'));
    expect(r).toBeDefined();
    const text = (r!.content![0] as { text: string }).text;
    expect(text).toContain('[redacted');
    expect(text).not.toContain('xyz');
  });

  it('未命中 → undefined(pi 保持原执行结果)', async () => {
    expect(await hook(afterCtx('hostname: fuzz'))).toBeUndefined();
  });

  it('多块结果:只净化命中块,干净块原样保留', async () => {
    const ctx = {
      toolCall: { type: 'toolCall', id: 't1', name: 'env_exec', arguments: {} },
      result: {
        content: [
          { type: 'text', text: 'clean output' },
          { type: 'text', text: 'see C:\\Users\\me\\secret' },
        ],
        details: {},
      },
      isError: false,
    } as never;
    const r = await hook(ctx);
    expect(r!.content![0]).toEqual({ type: 'text', text: 'clean output' });
    expect((r!.content![1] as { text: string }).text).toContain('[redacted');
  });

  it('图片块原样透传', async () => {
    const ctx = {
      toolCall: { type: 'toolCall', id: 't1', name: 'env_exec', arguments: {} },
      result: {
        content: [{ type: 'image', data: 'base64', mimeType: 'image/png' }],
        details: {},
      },
      isError: false,
    } as never;
    expect(await hook(ctx)).toBeUndefined();
  });

  it('规则异常按净化处理(与 boundary 同向:宁可错杀)', async () => {
    const badHook = makeOutputGuardHook({
      rules: [{ name: 'boom', check: () => { throw new Error('rule bug'); } }],
    });
    const r = await badHook(afterCtx('anything'));
    expect((r!.content![0] as { text: string }).text).toContain('[redacted');
  });
});
