/**
 * vmrun-path 单测：注册表输出解析（纯函数部分）。
 * resolveVmrunBinary 本身依赖机器状态（PATH/注册表），不在单测范围——
 * 它的正确性由全流程实测覆盖。
 */
import { describe, expect, it } from 'vitest';

import { parseRegInstallPath, VMWARE_REGISTRY_HIVES } from './vmrun-path';

describe('parseRegInstallPath', () => {
  it('parses reg query output (REG_SZ)', () => {
    const out = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation',
      '    InstallPath    REG_SZ    D:\\vm\\',
      '',
      '',
    ].join('\r\n');
    expect(parseRegInstallPath(out)).toBe('D:\\vm\\');
  });

  it('parses REG_EXPAND_SZ too', () => {
    const out = '    InstallPath    REG_EXPAND_SZ    C:\\Program Files (x86)\\VMware\\VMware Workstation\\\r\n';
    expect(parseRegInstallPath(out)).toBe('C:\\Program Files (x86)\\VMware\\VMware Workstation\\');
  });

  it('no match → undefined', () => {
    expect(parseRegInstallPath('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined();
    expect(parseRegInstallPath('')).toBeUndefined();
  });

  it('registry hives cover WOW6432Node and native', () => {
    expect(VMWARE_REGISTRY_HIVES.some((h) => h.includes('WOW6432Node'))).toBe(true);
    expect(VMWARE_REGISTRY_HIVES.some((h) => !h.includes('WOW6432Node'))).toBe(true);
  });
});
