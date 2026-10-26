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
