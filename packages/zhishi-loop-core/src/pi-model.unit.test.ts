import { describe, expect, it } from 'vitest';

import { buildLoopModel } from './pi-model';

// 2.2.2：reasoning 系 Kimi 模型必须走 openai-completions（reasoning_content 分离），
// 否则思维链会作为正文流出（“Let me call/Let me do it” 接龙）。
describe('Kimi reasoning 模型路由', () => {
  it('kimi-for-coding → openai-completions，maxTokens 用目录真实值', () => {
    const r = buildLoopModel({
      providerId: 'kimi', modelId: 'kimi-for-coding', apiProtocol: 'anthropic', apiKey: 'test',
    });
    expect(r.model.api).toBe('openai-completions');
    expect(r.model.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(r.model.reasoning).toBe(true);
    expect(r.model.maxTokens).toBe(32_768);
    expect((r.model as { compat?: { thinkingFormat?: string } }).compat?.thinkingFormat).toBe('openai');
  });

  it('k3 仍走 openai 通道，且保留 reasoning_effort 支持', () => {
    const r = buildLoopModel({ providerId: 'kimi', modelId: 'k3', apiProtocol: 'anthropic', apiKey: 'test' });
    expect(r.model.api).toBe('openai-completions');
    expect((r.model as { compat?: { supportsReasoningEffort?: boolean } }).compat?.supportsReasoningEffort).toBe(true);
  });

  it('非 kimi provider 的 anthropic 协议不受影响', () => {
    const r = buildLoopModel({
      providerId: 'anthropic-api', modelId: 'claude-sonnet-4-6', apiProtocol: 'anthropic', apiKey: 'test',
    });
    expect(r.model.api).toBe('anthropic-messages');
  });
});

// 2.2.x\uff1aprovider \u7ea7\u4e32\u884c\u5de5\u5177\u8c03\u7528\u5f00\u5173\u5fc5\u987b\u900f\u4f20\u5230\u89e3\u6790\u7ed3\u679c
// \uff08chat-engine \u9760\u5b83\u51b3\u5b9a\u662f\u5426\u62fc SERIAL_TOOL_CALL_RULE\uff09\u3002
describe('serialToolCalls \u900f\u4f20', () => {
  it('openai \u534f\u8bae\u4e0b\u5f00\u5173\u4fdd\u7559', () => {
    const r = buildLoopModel({
      providerId: 'freebuf-tapi', modelId: 'deepseek-flash-cyber', apiProtocol: 'openai',
      baseUrl: 'https://example.test/v1', apiKey: 'test', serialToolCalls: true,
    });
    expect(r.serialToolCalls).toBe(true);
  });

  it('\u672a\u5f00\u5173\u65f6\u4e3a\u7a7a', () => {
    const r = buildLoopModel({
      providerId: 'tophant-scc', modelId: 'claude-opus-4-7', apiProtocol: 'anthropic', apiKey: 'test',
    });
    expect(r.serialToolCalls).toBeUndefined();
  });
});
