/**
 * 模型选择器过滤测试（1.3.6）：显示=可运行（provider 已配 key 且未禁用），
 * 当前生效模型即使异常（未配 key/禁用）也保留显示。
 */
import { describe, expect, it } from 'vitest';

import type { ModelProvider } from '../client/api';
import { pickModelPickerProviders } from './model-picker';

function provider(overrides: Partial<ModelProvider>): ModelProvider {
  return {
    id: 'p',
    models: [
      { model: 'm-a', contextLength: 200_000 },
      { model: 'm-b', contextLength: 100_000 },
    ],
    ...overrides,
  };
}

describe('pickModelPickerProviders（只显示已配 key）', () => {
  it('已配 key + 未禁用 → 全量模型', () => {
    const out = pickModelPickerProviders([provider({ id: 'a', hasApiKey: true })], undefined);
    expect(out).toEqual([
      { id: 'a', models: [{ model: 'm-a', contextLength: 200_000 }, { model: 'm-b', contextLength: 100_000 }] },
    ]);
  });

  it('未配 key → 整组过滤（显示=可运行）', () => {
    const out = pickModelPickerProviders([provider({ id: 'a', hasApiKey: false })], undefined);
    expect(out).toEqual([]);
  });

  it('hasApiKey 缺省（旧 sidecar 口径）→ 视为未配，过滤', () => {
    const out = pickModelPickerProviders([provider({ id: 'a' })], undefined);
    expect(out).toEqual([]);
  });

  it('禁用的 provider 过滤', () => {
    const out = pickModelPickerProviders([provider({ id: 'a', hasApiKey: true, enabled: false })], undefined);
    expect(out).toEqual([]);
  });

  it('当前生效模型即使未配 key 也保留显示', () => {
    const out = pickModelPickerProviders([provider({ id: 'a', hasApiKey: false })], 'm-a');
    expect(out).toEqual([{ id: 'a', models: [{ model: 'm-a', contextLength: 200_000 }] }]);
  });

  it('当前生效模型即使 provider 禁用也保留显示', () => {
    const out = pickModelPickerProviders(
      [provider({ id: 'a', hasApiKey: true, enabled: false })],
      'm-b',
    );
    expect(out).toEqual([{ id: 'a', models: [{ model: 'm-b', contextLength: 100_000 }] }]);
  });

  it('未配 key 且当前模型不在此 provider → 整组过滤', () => {
    const out = pickModelPickerProviders([provider({ id: 'a', hasApiKey: false })], 'other-model');
    expect(out).toEqual([]);
  });
});
