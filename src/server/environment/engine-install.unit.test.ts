/**
 * 安全研究员版 P1 E1b — 引擎自动安装引导（engine-install）unit tests.
 *
 * 全部通过注入的 exec / download / launch 断言命令组装与流程编排，绝不真调
 * docker/wsl/dism/powershell，也不真发网络请求。下载目录用真临时目录
 * （验签失败即删的分支需要真实文件系统断言）。覆盖：签名判定、dism/elevated
 * 命令组装、docker 全流程（下载→验签→launch）、验签失败即删、hyperv 已启用/
 * 启用成功/非管理员拦截/dism 失败、非 Windows 指引、已就绪短路。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DOCKER_DESKTOP_URL,
  DOCKER_INSTALLER_FILENAME,
  buildDismEnableHyperVArgs,
  buildDockerVerifyArgs,
  buildElevatedCheckArgs,
  buildWslStatusArgs,
  installEngine,
  nonWindowsGuidance,
  parseDockerSignature,
  parseElevatedResult,
} from './engine-install';
import type { EngineExec, EngineExecResult } from './engines';

function ok(stdout = ''): EngineExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr = ''): EngineExecResult {
  return { exitCode: 1, stdout: '', stderr };
}

/** Scriptable exec: records argv, replays queued results in order. */
function scriptedExec(queue: Array<EngineExecResult | ((argv: string[]) => EngineExecResult)>) {
  const calls: string[][] = [];
  const exec: EngineExec = async (argv) => {
    calls.push(argv);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected exec: ${argv.join(' ')}`);
    return typeof next === 'function' ? next(argv) : next;
  };
  return { exec, calls };
}

const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhishi-engine-install-test-'));
  tempRoots.push(root);
  return root;
}
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('parsing (pure)', () => {
  it('parseDockerSignature：Valid + Docker 签发者才通过', () => {
    expect(parseDockerSignature('Valid|CN=Docker Inc, O=Docker Inc, L=Portland')).toBe(true);
    expect(parseDockerSignature('Valid|CN=Evil Corp')).toBe(false);
    expect(parseDockerSignature('NotSigned|CN=Docker Inc')).toBe(false);
    expect(parseDockerSignature('HashMismatch|CN=Docker Inc')).toBe(false);
    expect(parseDockerSignature('')).toBe(false);
  });

  it('parseElevatedResult：只认 True', () => {
    expect(parseElevatedResult('True')).toBe(true);
    expect(parseElevatedResult('True\r\n')).toBe(true);
    expect(parseElevatedResult('False')).toBe(false);
    expect(parseElevatedResult('')).toBe(false);
  });

  it('nonWindowsGuidance：docker 按平台给 brew/apt 指引，hyperv 指向其他 hypervisor', () => {
    expect(nonWindowsGuidance('docker', 'darwin')).toContain('brew install --cask docker');
    expect(nonWindowsGuidance('docker', 'linux')).toContain('apt');
    expect(nonWindowsGuidance('hyperv', 'darwin')).toContain('仅 Windows');
  });
});

describe('command assembly (pure)', () => {
  it('buildDockerVerifyArgs：Get-AuthenticodeSignature 输出 Status|Subject，单引号转义', () => {
    const args = buildDockerVerifyArgs("C:\\x\\it's\\Docker Desktop Installer.exe");
    expect(args[0]).toBe('powershell');
    expect(args.join(' ')).toContain('Get-AuthenticodeSignature');
    expect(args.join(' ')).toContain("'C:\\x\\it''s\\Docker Desktop Installer.exe'");
    expect(args.join(' ')).toContain('$($s.Status)|$($s.SignerCertificate.Subject)');
  });

  it('buildDismEnableHyperVArgs：dism 启用 Hyper-V 全部子功能且不重启', () => {
    expect(buildDismEnableHyperVArgs()).toEqual([
      'dism.exe', '/online', '/enable-feature',
      '/featurename:Microsoft-Hyper-V-All', '/all', '/norestart',
    ]);
  });

  it('buildElevatedCheckArgs：WindowsPrincipal IsInRole(Administrator)', () => {
    const args = buildElevatedCheckArgs();
    expect(args[0]).toBe('powershell');
    expect(args.join(' ')).toContain('IsInRole');
    expect(args.join(' ')).toContain('Administrator');
  });

  it('buildWslStatusArgs：wsl.exe --status', () => {
    expect(buildWslStatusArgs()).toEqual(['wsl.exe', '--status']);
  });
});

describe('installEngine docker', () => {
  it('docker 已可用：docker info 成功即短路报已就绪，不下载不启动', async () => {
    const { exec, calls } = scriptedExec([ok('27.3.1')]);
    let downloaded = false;
    let launched = false;
    const result = await installEngine('docker', {
      exec,
      download: async () => { downloaded = true; },
      launch: async () => { launched = true; },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyAvailable).toBe(true);
      expect(result.message).toContain('已就绪');
    }
    expect(calls).toEqual([['docker', 'info', '--format', '{{.ServerVersion}}']]);
    expect(downloaded).toBe(false);
    expect(launched).toBe(false);
  });

  it('全流程：探测缺失 → wsl 提示 → 下载官方 URL → 验签 → 启动安装器', async () => {
    const downloadsDir = makeTempRoot();
    const { exec, calls } = scriptedExec([
      fail('Cannot connect to the Docker daemon'),  // docker info 失败
      ok(),                                          // wsl --status 正常
      ok('Valid|CN=Docker Inc, O=Docker Inc'),       // Authenticode 验签
    ]);
    let downloadUrl = '';
    let launchedPath = '';
    const result = await installEngine('docker', {
      exec,
      downloadsDir,
      download: async (url) => { downloadUrl = url; },
      launch: async (p) => { launchedPath = p; },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyAvailable).toBeUndefined();
    expect(downloadUrl).toBe(DOCKER_DESKTOP_URL);
    const expectedDest = join(downloadsDir, DOCKER_INSTALLER_FILENAME);
    expect(result.installerPath).toBe(expectedDest);
    expect(launchedPath).toBe(expectedDest);
    expect(result.message).toContain('安装器已启动');
    expect(result.message).toContain('WSL2 已就绪');
    // exec 顺序：docker info → wsl --status → 验签
    expect(calls[0][0]).toBe('docker');
    expect(calls[1]).toEqual(['wsl.exe', '--status']);
    expect(calls[2].join(' ')).toContain('Get-AuthenticodeSignature');
  });

  it('WSL2 未就绪不阻断：提示语换成「安装器会引导启用」', async () => {
    const { exec } = scriptedExec([
      fail(),                          // docker info 失败
      fail('WSL is not installed'),    // wsl --status 失败
      ok('Valid|CN=Docker Inc'),
    ]);
    const result = await installEngine('docker', {
      exec,
      downloadsDir: makeTempRoot(),
      download: async () => undefined,
      launch: async () => undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toContain('安装器会引导启用');
  });

  it('验签失败：删除安装包并报错，绝不 launch', async () => {
    const downloadsDir = makeTempRoot();
    const dest = join(downloadsDir, DOCKER_INSTALLER_FILENAME);
    const { exec } = scriptedExec([
      fail(),                          // docker info
      ok(),                            // wsl --status
      ok('Valid|CN=Evil Corp'),        // 签发者不是 Docker
    ]);
    let launched = false;
    const result = await installEngine('docker', {
      exec,
      downloadsDir,
      download: async () => { writeFileSync(dest, 'fake-installer'); },
      launch: async () => { launched = true; },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('签名验证失败');
    expect(existsSync(dest)).toBe(false);
    expect(launched).toBe(false);
  });

  it('下载失败：报手动下载指引', async () => {
    const { exec } = scriptedExec([fail(), ok()]);
    const result = await installEngine('docker', {
      exec,
      downloadsDir: makeTempRoot(),
      download: async () => { throw new Error('HTTP 403'); },
      launch: async () => undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('下载失败');
      expect(result.error).toContain('HTTP 403');
    }
  });
});

describe('installEngine hyperv', () => {
  it('hyperv 已启用：Get-VM 探测成功即短路', async () => {
    const { exec, calls } = scriptedExec([ok('ok')]);
    const result = await installEngine('hyperv', { exec });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyAvailable).toBe(true);
    expect(calls).toEqual([['powershell', '-NoProfile', '-Command', "Get-VM | Out-Null; 'ok'"]]);
  });

  it('启用成功：elevated → dism → 提示重启生效', async () => {
    const { exec, calls } = scriptedExec([
      fail(),        // Get-VM 探测失败（功能未启用）
      ok('True'),    // elevated
      ok(),          // dism 成功
    ]);
    const result = await installEngine('hyperv', { exec });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toContain('需重启');
    expect(calls[2]).toEqual(buildDismEnableHyperVArgs());
  });

  it('非管理员：报清晰错误，绝不执行 dism', async () => {
    const { exec, calls } = scriptedExec([
      fail(),        // Get-VM 探测失败
      ok('False'),   // 非 elevated
    ]);
    const result = await installEngine('hyperv', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('需要管理员权限');
    expect(calls.some((c) => c[0] === 'dism.exe')).toBe(false);
  });

  it('dism 失败：stderr 首行进入错误文案', async () => {
    const { exec } = scriptedExec([
      fail(),
      ok('True'),
      fail('Error: 1168\nElement not found.'),
    ]);
    const result = await installEngine('hyperv', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('启用 Hyper-V 失败');
      expect(result.error).toContain('Error: 1168');
    }
  });
});

describe('installEngine 平台闸门', () => {
  it('非 Windows：给指引文案，不执行任何安装动作', async () => {
    const { exec, calls } = scriptedExec([fail()]);  // 探测缺失
    const result = await installEngine('docker', {
      exec,
      platform: 'darwin',
      download: async () => { throw new Error('不该被调用'); },
      launch: async () => { throw new Error('不该被调用'); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('brew install --cask docker');
    expect(calls).toHaveLength(1);  // 只有探测那一次
  });

  it('linux 上 hyperv：指引改用其他 hypervisor', async () => {
    const { exec } = scriptedExec([fail()]);
    const result = await installEngine('hyperv', { exec, platform: 'linux' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('仅 Windows');
  });
});
