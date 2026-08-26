/**
 * admin intel 配置部分更新 handler 测试（1.3.2 任务二 #3）——PATCH 语义。
 *
 * atomicModifyConfig 用注入版（内存对象 + 记录 modifier 调用），绝不写真实
 * ~/.zhishi/config.json。覆盖:合法部分更新(只改传入字段/其余保持/回写)、
 * 非法 mode/windowYears/maxSizeMb/onlineFallback 拒绝(不回写)、空补丁拒绝。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleIntelConfigUpdate } from '../admin-api';
import type { IntelConfig } from '../../shared/config-types';

// 内存 config + 记录 modifier 调用(替代真实 atomicModifyConfig)。
let memConfig: { intel?: IntelConfig; other?: string };
const modifierSpy = vi.fn<(modifier: unknown) => void>();

vi.mock('../utils/admin-config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/admin-config')>();
  return {
    ...orig,
    atomicModifyConfig: async (modifier: (c: { intel?: IntelConfig; other?: string }) => { intel?: IntelConfig; other?: string }) => {
      modifierSpy(modifier);
      memConfig = modifier(memConfig);
      return memConfig;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  memConfig = { intel: { mode: 'window', windowYears: 3, maxSizeMb: 300, onlineFallback: true }, other: 'keep-me' };
});

describe('handleIntelConfigUpdate（PATCH 语义，回写 config.json::intel）', () => {
  it('只改传入字段并回写:mode 改 full,其余字段与无关段保持', async () => {
    const r = await handleIntelConfigUpdate({ mode: 'full' });
    expect(r.success).toBe(true);
    // 回写内容 = 原 intel 合并补丁;无关段 other 原样保留
    expect(memConfig.intel).toEqual({ mode: 'full', windowYears: 3, maxSizeMb: 300, onlineFallback: true });
    expect(memConfig.other).toBe('keep-me');
    // 返回 resolveIntelConfig 合并值
    expect((r.data as { config: Required<IntelConfig> }).config).toEqual({
      mode: 'full', windowYears: 3, maxSizeMb: 300, onlineFallback: true,
    });
  });

  it('多字段部分更新:未传字段保持原值(partial,不是全量覆盖)', async () => {
    const r = await handleIntelConfigUpdate({ windowYears: 5, onlineFallback: false });
    expect(r.success).toBe(true);
    expect(memConfig.intel).toEqual({ mode: 'window', windowYears: 5, maxSizeMb: 300, onlineFallback: false });
  });

  it('config 无 intel 段时按空对象合并(不炸)', async () => {
    memConfig = { other: 'x' };
    const r = await handleIntelConfigUpdate({ mode: 'minimal' });
    expect(r.success).toBe(true);
    expect(memConfig.intel).toEqual({ mode: 'minimal' });
    expect((r.data as { config: Required<IntelConfig> }).config.mode).toBe('minimal');
  });

  it('非法 mode → 拒绝且不回写', async () => {
    const r = await handleIntelConfigUpdate({ mode: 'everything' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('非法 mode');
    expect(modifierSpy).not.toHaveBeenCalled();
  });

  it('非法 windowYears/maxSizeMb(非正数/NaN)→ 拒绝', async () => {
    for (const payload of [{ windowYears: 0 }, { windowYears: -1 }, { windowYears: Number.NaN }, { windowYears: '3' }]) {
      const r = await handleIntelConfigUpdate(payload);
      expect(r.success).toBe(false);
      expect(r.error).toContain('windowYears');
    }
    for (const payload of [{ maxSizeMb: 0 }, { maxSizeMb: -5 }, { maxSizeMb: Number.NaN }, { maxSizeMb: '300' }]) {
      const r = await handleIntelConfigUpdate(payload);
      expect(r.success).toBe(false);
      expect(r.error).toContain('maxSizeMb');
    }
    expect(modifierSpy).not.toHaveBeenCalled();
  });

  it('非法 onlineFallback(非布尔)→ 拒绝', async () => {
    const r = await handleIntelConfigUpdate({ onlineFallback: 'yes' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('onlineFallback');
    expect(modifierSpy).not.toHaveBeenCalled();
  });

  it('空补丁 → 拒绝(没有可更新字段)', async () => {
    const r = await handleIntelConfigUpdate({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('没有可更新的字段');
    expect(modifierSpy).not.toHaveBeenCalled();
  });
});
