/**
 * 2.0-M1：同名环境合并守卫单测（纯函数，不依赖 HTTP/配置层）。
 */

import { describe, expect, it } from 'vitest';

import { canMergeEntries, mergeNameOf, sameUnderlyingTarget } from './env-merge';

describe('mergeNameOf / sameUnderlyingTarget', () => {
  it('name 优先、trim + 小写；缺 name 回落 id', () => {
    expect(mergeNameOf({ id: 'a', name: ' Fuzz ' })).toBe('fuzz');
    expect(mergeNameOf({ id: 'Kali' })).toBe('kali');
  });

  it('docker：同容器算同目标（大小写/空白不敏感）；不同容器/空容器不算', () => {
    expect(
      sameUnderlyingTarget(
        { id: 'a', kind: 'docker', container: 'fuzz-ct' },
        { id: 'b', kind: 'docker', container: ' FUZZ-CT ' },
      ),
    ).toBe(true);
    expect(
      sameUnderlyingTarget(
        { id: 'a', kind: 'docker', container: 'a-ct' },
        { id: 'b', kind: 'docker', container: 'b-ct' },
      ),
    ).toBe(false);
    expect(
      sameUnderlyingTarget({ id: 'a', kind: 'docker' }, { id: 'b', kind: 'docker' }),
    ).toBe(false);
  });

  it('vm：vmName 优先、回落 vmx；ssh：同 host 才算；kind 不同永不算', () => {
    expect(
      sameUnderlyingTarget(
        { id: 'a', kind: 'vm', vmName: 'Fuzz-VM' },
        { id: 'b', kind: 'vm', vmName: 'fuzz-vm' },
      ),
    ).toBe(true);
    expect(
      sameUnderlyingTarget(
        { id: 'a', kind: 'vm', vmx: 'D:\\VM\\fuzz.vmx' },
        { id: 'b', kind: 'vm', vmx: 'D:\\VM\\fuzz.vmx' },
      ),
    ).toBe(true);
    expect(
      sameUnderlyingTarget({ id: 'a', kind: 'ssh', host: '10.0.0.2' }, { id: 'b', kind: 'ssh', host: '10.0.0.2' }),
    ).toBe(true);
    expect(
      sameUnderlyingTarget(
        { id: 'a', kind: 'docker', container: 'x' },
        { id: 'b', kind: 'vm', vmName: 'x' },
      ),
    ).toBe(false);
  });
});

describe('canMergeEntries（双守卫）', () => {
  it('同名 + 不同目标 → 允许', () => {
    expect(
      canMergeEntries(
        { id: 'fuzz', kind: 'docker', name: 'fuzz', container: 'new-ct' },
        { id: 'fuzz-old', kind: 'docker', name: 'fuzz', container: 'old-ct' },
      ),
    ).toEqual({ ok: true });
  });

  it('不同名 → 拒绝（错误文案带两者名）', () => {
    const v = canMergeEntries(
      { id: 'a', kind: 'docker', name: 'alpha' },
      { id: 'b', kind: 'docker', name: 'beta' },
    );
    expect(v.ok).toBe(false);
    expect(v.error).toContain('不同名');
  });

  it('同名 + 同容器 → 拒绝（引导逐个 rm）', () => {
    const v = canMergeEntries(
      { id: 'a', kind: 'docker', name: 'fuzz', container: 'same-ct' },
      { id: 'b', kind: 'docker', name: 'fuzz', container: 'same-ct' },
    );
    expect(v.ok).toBe(false);
    expect(v.error).toContain('同一底层目标');
  });
});
