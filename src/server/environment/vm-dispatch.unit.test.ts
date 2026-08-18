/**
 * 安全研究员版 P2 B3 — VM 驱动分发纯函数 unit tests.
 *
 * 覆盖：resolveVmDriver（frontmatter vm_engine 缺省 vmware、hyperv /
 * virtualbox 映射到 hyperv / vbox）与 routeVmTarget（vmware 目录命中 →
 * hyperv 名字命中 → vbox 名字命中 → docker 兜底的固定优先级，含撞名时
 * 先到先得）。
 */
import { describe, expect, it } from 'vitest';

import { resolveVmDriver, routeVmTarget } from './vm-dispatch';

describe('resolveVmDriver', () => {
  it('defaults to vmware when vm_engine is absent (历史行为不变)', () => {
    expect(resolveVmDriver({})).toBe('vmware');
    expect(resolveVmDriver({ vmEngine: 'vmware' })).toBe('vmware');
  });

  it('maps hyperv / virtualbox frontmatter values', () => {
    expect(resolveVmDriver({ vmEngine: 'hyperv' })).toBe('hyperv');
    expect(resolveVmDriver({ vmEngine: 'virtualbox' })).toBe('vbox');
  });
});

describe('routeVmTarget', () => {
  const none = { vmwareInstance: false, hypervVm: false, vboxVm: false };

  it('vmware instance dir hit wins first', () => {
    expect(routeVmTarget({ ...none, vmwareInstance: true })).toBe('vmware');
  });

  it('hyperv name hit wins over vbox and docker', () => {
    expect(routeVmTarget({ ...none, hypervVm: true })).toBe('hyperv');
    expect(routeVmTarget({ ...none, hypervVm: true, vboxVm: true })).toBe('hyperv');
  });

  it('vbox name hit wins over docker', () => {
    expect(routeVmTarget({ ...none, vboxVm: true })).toBe('vbox');
  });

  it('no hits → docker fallback', () => {
    expect(routeVmTarget(none)).toBe('docker');
  });

  it('full collision → fixed priority vmware > hyperv > vbox', () => {
    expect(routeVmTarget({ vmwareInstance: true, hypervVm: true, vboxVm: true })).toBe('vmware');
  });
});
