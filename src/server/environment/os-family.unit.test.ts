/**
 * os-family unit tests — OS 家族判定 + PowerShell 编码 + 捕获包装形状。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  osFamilyOf,
  psEncode,
  psEmbedCommand,
  psCaptureScript,
  psShellWrapper,
  osFamilyFromGuestOS,
  detectOsFamilyFromVmx,
  PS_TEMP,
} from './os-family';

describe('osFamilyOf', () => {
  it('windows 显式声明;其余(含缺省/linux)→ linux', () => {
    expect(osFamilyOf({ osFamily: 'windows' })).toBe('windows');
    expect(osFamilyOf({ osFamily: 'linux' })).toBe('linux');
    expect(osFamilyOf({})).toBe('linux');
    expect(osFamilyOf({ osFamily: 'freebsd' as 'linux' })).toBe('linux');
  });
});

describe('PowerShell 编码(双 base64 封装)', () => {
  it('psEncode 是 utf16le base64;往返解码正确', () => {
    const enc = psEncode('echo hi');
    expect(Buffer.from(enc, 'base64').toString('utf16le')).toBe('echo hi');
  });

  it('psEmbedCommand 是 utf8 base64(命令本体第二层)', () => {
    const enc = psEmbedCommand('echo "引号" && echo 换行\ntest');
    expect(Buffer.from(enc, 'base64').toString('utf8')).toBe('echo "引号" && echo 换行\ntest');
  });
});

describe('Windows 捕获包装', () => {
  it('psCaptureScript:命令不裸进脚本,落 out/code 路径', () => {
    const s = psCaptureScript('echo "x" > y', `${PS_TEMP}\\a.out`, `${PS_TEMP}\\a.code`);
    expect(s).not.toContain('echo "x"'); // 命令本体 b64 封装
    expect(s).toContain('cmd /c $c'); // 经 cmd 执行,退出码可靠
    expect(s).toContain('$LASTEXITCODE');
    expect(s).toContain('a.out');
    expect(s).toContain('a.code');
  });

  it('psShellWrapper:ssh 通道的退出码透传(exit $LASTEXITCODE)', () => {
    const s = psShellWrapper('dir C:\\');
    expect(s).toContain('cmd /c $c');
    expect(s).toContain('exit $LASTEXITCODE');
    expect(s).not.toContain('dir C:'); // b64 封装
  });
});

describe('vmx 静态探测(guestOS 字段)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-vmx-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('guestOS 字符串分族:win* → windows;其余/空 → linux', () => {
    expect(osFamilyFromGuestOS('windows9-64')).toBe('windows');
    expect(osFamilyFromGuestOS('win2000')).toBe('windows');
    expect(osFamilyFromGuestOS('ubuntu-64')).toBe('linux');
    expect(osFamilyFromGuestOS('darwin24-64')).toBe('linux');
    expect(osFamilyFromGuestOS(undefined)).toBe('linux');
  });

  it('从 .vmx 文件读 guestOS;读不到 → null', () => {
    const winVmx = join(dir, 'win.vmx');
    writeFileSync(winVmx, '.encoding = "UTF-8"\nguestOS = "windows11-64"\n', 'utf-8');
    expect(detectOsFamilyFromVmx(winVmx)).toBe('windows');
    const linVmx = join(dir, 'lin.vmx');
    writeFileSync(linVmx, 'guestOS = "ubuntu-64"\n', 'utf-8');
    expect(detectOsFamilyFromVmx(linVmx)).toBe('linux');
    expect(detectOsFamilyFromVmx(join(dir, 'nope.vmx'))).toBeNull();
    const bareVmx = join(dir, 'bare.vmx');
    writeFileSync(bareVmx, 'displayName = "x"\n', 'utf-8');
    expect(detectOsFamilyFromVmx(bareVmx)).toBeNull();
  });
});
