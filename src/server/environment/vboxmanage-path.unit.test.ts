/**
 * vboxmanage-path 单测：注册表输出解析（纯函数部分）。
 * resolveVBoxManageBinary 本身依赖机器状态（PATH/注册表），不在单测范围。
 */
import { describe, expect, it } from 'vitest';

import { parseRegInstallDir, VIRTUALBOX_REGISTRY_HIVES } from './vboxmanage-path';

describe('parseRegInstallDir', () => {
  it('parses reg query output (REG_SZ)', () => {
    const out = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Oracle\\VirtualBox',
      '    InstallDir    REG_SZ    C:\\Program Files\\Oracle\\VirtualBox\\',
      '',
      '',
    ].join('\r\n');
    expect(parseRegInstallDir(out)).toBe('C:\\Program Files\\Oracle\\VirtualBox\\');
  });

  it('parses REG_EXPAND_SZ too', () => {
    const out = '    InstallDir    REG_EXPAND_SZ    D:\\Apps\\VirtualBox\\\r\n';
    expect(parseRegInstallDir(out)).toBe('D:\\Apps\\VirtualBox\\');
  });

  it('no match → undefined', () => {
    expect(parseRegInstallDir('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined();
    expect(parseRegInstallDir('')).toBeUndefined();
  });

  it('registry hives cover WOW6432Node and native', () => {
    expect(VIRTUALBOX_REGISTRY_HIVES.some((h) => h.includes('WOW6432Node'))).toBe(true);
    expect(VIRTUALBOX_REGISTRY_HIVES.some((h) => !h.includes('WOW6432Node'))).toBe(true);
  });
});
