/**
 * custom-provider.test.ts — 1.4.10 #6 自定义供应商表单模型层单测。
 *
 * 覆盖：模型 ID 解析（分隔/去重/保序）、payload 组装（协议/authType/主模型
 * 缺省）、本地校验与服务端同口径（id 字符集/baseUrl/模型非空/主模型在列）。
 */
import { describe, expect, it } from 'vitest';

import { buildCustomProviderPayload, parseModelIds } from './custom-provider';

const BASE = {
  id: 'my-relay',
  name: 'XX 中转站',
  baseUrl: 'https://relay.example.com/v1',
  protocol: 'openai' as const,
  modelsRaw: 'gpt-4o, claude-sonnet-4-5',
  primaryModel: '',
};

describe('parseModelIds（分隔/去重/保序）', () => {
  it('逗号/空格/换行/中文分隔符混合，去重保序', () => {
    expect(parseModelIds('gpt-4o, claude-sonnet-4-5\ngpt-4o，deepseek-v4-pro')).toEqual([
      'gpt-4o',
      'claude-sonnet-4-5',
      'deepseek-v4-pro',
    ]);
  });
  it('空输入 → []', () => {
    expect(parseModelIds('  ,、 ')).toEqual([]);
  });
});

describe('buildCustomProviderPayload', () => {
  it('合法输入 → provider payload（主模型缺省 = 列表首个，authType=auth_token）', () => {
    const r = buildCustomProviderPayload(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toMatchObject({
      id: 'my-relay',
      name: 'XX 中转站',
      baseUrl: 'https://relay.example.com/v1',
      protocol: 'openai',
      models: ['gpt-4o', 'claude-sonnet-4-5'],
      primaryModel: 'gpt-4o',
      authType: 'auth_token',
    });
  });

  it('baseUrl 尾部斜杠剥掉', () => {
    const r = buildCustomProviderPayload({ ...BASE, baseUrl: 'https://relay.example.com/v1/' });
    expect(r.ok && r.provider.baseUrl).toBe('https://relay.example.com/v1');
  });

  it('校验：id 空/非法字符、名称空、baseUrl 非 http、模型空、主模型不在列', () => {
    expect(buildCustomProviderPayload({ ...BASE, id: '' })).toMatchObject({ ok: false });
    expect(buildCustomProviderPayload({ ...BASE, id: '我的站' })).toMatchObject({ ok: false });
    expect(buildCustomProviderPayload({ ...BASE, name: ' ' })).toMatchObject({ ok: false });
    expect(buildCustomProviderPayload({ ...BASE, baseUrl: 'relay.example.com' })).toMatchObject({ ok: false });
    expect(buildCustomProviderPayload({ ...BASE, modelsRaw: ' ' })).toMatchObject({ ok: false });
    const r = buildCustomProviderPayload({ ...BASE, primaryModel: 'not-in-list' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不在模型列表');
  });
});
