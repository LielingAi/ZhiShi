/**
 * 情报配置纯函数测试（1.3.6）：
 *   - buildIntelConfigPatch 的 PATCH 语义（只传改动字段、其余字段不丢）
 *   - 非法 windowYears/maxSizeMb 拒绝且不产出部分补丁
 *   - resolved=null 时按服务端缺省基线 diff（mode 缺省 minimal）
 *   - 三模式中文标签/说明齐全（无英文裸标签回归）
 */
import { describe, expect, it } from 'vitest';

import {
  buildIntelConfigPatch,
  INTEL_MODE_DEFAULT,
  INTEL_MODE_META,
  INTEL_MODES,
  type IntelConfigForm,
  type IntelResolvedConfig,
} from './intel-config';

const RESOLVED: IntelResolvedConfig = {
  mode: 'minimal',
  windowYears: 3,
  maxSizeMb: 300,
  onlineFallback: true,
};

const FORM: IntelConfigForm = {
  mode: 'minimal',
  windowYears: '3',
  maxSizeMb: '300',
  onlineFallback: true,
};

describe('buildIntelConfigPatch（PATCH 语义，只传改动字段）', () => {
  it('无改动 → 空补丁', () => {
    const r = buildIntelConfigPatch(FORM, RESOLVED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({});
  });

  it('只改 mode → 只传 mode，其余字段不丢', () => {
    const r = buildIntelConfigPatch({ ...FORM, mode: 'window' }, RESOLVED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ mode: 'window' });
  });

  it('改 windowYears + maxSizeMb → 数字类型透传', () => {
    const r = buildIntelConfigPatch({ ...FORM, windowYears: '5', maxSizeMb: '1024' }, RESOLVED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ windowYears: 5, maxSizeMb: 1024 });
  });

  it('onlineFallback 关 → 传 false（falsy 不被丢弃）', () => {
    const r = buildIntelConfigPatch({ ...FORM, onlineFallback: false }, RESOLVED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ onlineFallback: false });
  });

  it('非法 windowYears → error 且不产出部分补丁', () => {
    for (const bad of ['0', '-2', 'abc']) {
      const r = buildIntelConfigPatch({ ...FORM, mode: 'full', windowYears: bad }, RESOLVED);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('windowYears');
    }
  });

  it('非法 maxSizeMb → error', () => {
    const r = buildIntelConfigPatch({ ...FORM, maxSizeMb: '0' }, RESOLVED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('maxSizeMb');
  });

  it('resolved=null（status 未取到）→ diff 基线 = 服务端缺省（mode minimal）', () => {
    // 旧实现的基线是 'window'——表单初始态 'minimal' 会被误判为改动并送 mode。
    const fresh: IntelConfigForm = {
      mode: INTEL_MODE_DEFAULT,
      windowYears: '',
      maxSizeMb: '',
      onlineFallback: true,
    };
    const r = buildIntelConfigPatch(fresh, null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({});
    // 显式改动仍可送出（不含 mode 的误报）
    const r2 = buildIntelConfigPatch({ ...fresh, windowYears: '5' }, null);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.patch).toEqual({ windowYears: 5 });
  });
});

describe('模式中文标签（语义照服务端实现）', () => {
  it('三档齐全且都有中文 label + 说明（无英文裸名回归）', () => {
    expect(INTEL_MODES).toEqual(['minimal', 'window', 'full']);
    for (const m of INTEL_MODES) {
      const meta = INTEL_MODE_META[m];
      expect(meta.label).toBeTruthy();
      expect(meta.label).not.toMatch(/^[a-z]+$/);
      expect(meta.desc.length).toBeGreaterThan(10);
    }
    // 破坏性语义必须写明：window 会删窗口外历史 CVE
    expect(INTEL_MODE_META.window.desc).toContain('删除');
    expect(INTEL_MODE_META.window.desc).toContain('windowYears');
  });
});
