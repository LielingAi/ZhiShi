/**
 * tui-launch 单测：二进制查找序（env → npm 平台包 → dev 构建）与前台透传。
 * 不真 spawn——exit / error 用注入的假 child 驱动。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { launchTui, resolveCliInvocation, resolveTuiBinary, tuiPlatformPackage } from './tui-launch';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveTuiBinary', () => {
  it('平台包名按 platform-arch 拼（与构建脚本一致）', () => {
    expect(tuiPlatformPackage('win32', 'x64')).toBe('@lielingai/zhishi-tui-win32-x64');
    expect(tuiPlatformPackage('darwin', 'arm64')).toBe('@lielingai/zhishi-tui-darwin-arm64');
  });

  it('ZHISHI_TUI_BIN 命中即用（dev / 自定义构建）', () => {
    const dir = tempDir('zhishi-tui-bin-');
    const bin = join(dir, 'zhishi-tui.exe');
    writeFileSync(bin, '');
    expect(
      resolveTuiBinary({
        env: { ZHISHI_TUI_BIN: bin },
        platform: 'win32',
        resolveFromPackage: () => {
          throw new Error('不该走到平台包');
        },
      }),
    ).toBe(bin);
  });

  it('ZHISHI_TUI_BIN 指错 → null（显式配置不做静默回落）', () => {
    expect(
      resolveTuiBinary({
        env: { ZHISHI_TUI_BIN: join(tmpdir(), 'definitely-missing-zhishi-tui') },
        platform: 'win32',
        resolveFromPackage: () => null,
      }),
    ).toBeNull();
  });

  it('平台包（optionalDependencies）优先于 dev 构建', () => {
    const dir = tempDir('zhishi-tui-pkg-');
    const packaged = join(dir, 'bin', 'zhishi-tui.exe');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(packaged, '');

    const cwd = tempDir('zhishi-tui-cwd-');
    mkdirSync(join(cwd, 'src', 'tui'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'tui', 'zhishi-tui.exe'), '');

    expect(
      resolveTuiBinary({ env: {}, platform: 'win32', cwd, resolveFromPackage: () => packaged }),
    ).toBe(packaged);
  });

  it('平台包缺失 → 回落 <cwd>/src/tui（dev）', () => {
    const cwd = tempDir('zhishi-tui-cwd2-');
    mkdirSync(join(cwd, 'src', 'tui'), { recursive: true });
    const dev = join(cwd, 'src', 'tui', 'zhishi-tui.exe');
    writeFileSync(dev, '');
    expect(resolveTuiBinary({ env: {}, platform: 'win32', cwd, resolveFromPackage: () => null })).toBe(dev);
  });

  it('都没有 → null（调用方给可执行的指引）', () => {
    const cwd = tempDir('zhishi-tui-empty-');
    expect(resolveTuiBinary({ env: {}, platform: 'win32', cwd, resolveFromPackage: () => null })).toBeNull();
  });
});

describe('resolveCliInvocation', () => {
  it('dev（.ts 入口）：node + tsx 预加载 + 源文件', () => {
    expect(
      resolveCliInvocation({ selfPath: '/repo/src/cli/zhishi.ts', execPath: '/usr/bin/node', exists: () => false }),
    ).toEqual(['/usr/bin/node', '--import', 'tsx/esm', '/repo/src/cli/zhishi.ts']);
  });

  it('npm 捆绑产物：node + 同目录 cli.js（或它自己）', () => {
    expect(
      resolveCliInvocation({
        selfPath: '/pkg/dist/cli.js',
        execPath: 'C:/node/node.exe',
        exists: (p) => p === '/pkg/dist/cli.js' || p.endsWith('/dist/cli.js'),
      }),
    ).toEqual(['C:/node/node.exe', '/pkg/dist/cli.js']);
  });

  it('Tauri 形态（resources/cli/zhishi.js，没有 sibling cli.js）：用它自己', () => {
    expect(
      resolveCliInvocation({ selfPath: '/res/cli/zhishi.js', execPath: '/res/nodejs/node.exe', exists: () => false }),
    ).toEqual(['/res/nodejs/node.exe', '/res/cli/zhishi.js']);
  });
});

describe('launchTui', () => {
  it('找不到二进制 → 退出码 1 + 明确指引（不静默）', async () => {
    const logs: string[] = [];
    const code = await launchTui({ server: 'http://127.0.0.1:1', binary: null, log: (m) => logs.push(m) });
    expect(code).toBe(1);
    expect(logs[0]).toContain('未找到 zhishi TUI 二进制');
    expect(logs.some((m) => m.includes('ZHISHI_TUI_BIN'))).toBe(true);
  });

  it('前台透传 --server；token 走环境变量不进 argv', async () => {
    let seen: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const fakeChild = new EventEmitter() as EventEmitter & { exitCode: number | null };
    fakeChild.exitCode = null;
    const code = await launchTui({
      server: 'http://127.0.0.1:38002',
      token: 'tok-secret',
      extraArgs: ['--probe'],
      binary: 'C:/fake/zhishi-tui.exe',
      spawnImpl: ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        seen = { cmd, args, env: opts.env };
        setImmediate(() => fakeChild.emit('exit', 0, null));
        return fakeChild;
      }) as never,
    });
    expect(code).toBe(0);
    expect(seen?.cmd).toBe('C:/fake/zhishi-tui.exe');
    expect(seen?.args).toEqual(['--server', 'http://127.0.0.1:38002', '--probe']);
    expect(seen?.args.join(' ')).not.toContain('tok-secret');
    expect(seen?.env?.ZHISHI_TOKEN).toBe('tok-secret');
    // TUI 里 `/命令` 要靠这个跑 CLI：必须是可解析的 argv 数组，且首项是 node。
    const argv = JSON.parse(seen?.env?.ZHISHI_CLI_ARGV ?? '[]') as string[];
    expect(argv.length).toBeGreaterThanOrEqual(2);
    expect(argv[0]).toBe(process.execPath);
  });

  it('spawn 出错（不可执行等）→ 退出码 1，不抛', async () => {
    const fakeChild = new EventEmitter();
    const logs: string[] = [];
    const code = await launchTui({
      server: 'http://127.0.0.1:1',
      binary: 'C:/fake/zhishi-tui.exe',
      log: (m) => logs.push(m),
      spawnImpl: (() => {
        setImmediate(() => fakeChild.emit('error', new Error('EACCES')));
        return fakeChild;
      }) as never,
    });
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('EACCES');
  });
});

// 单包（--bundle）形态：二进制在本包 dist/tui/<platform>-<arch>/bin/ 下，
// 不依赖 registry 解析 optionalDependencies。
describe('resolveTuiBinary · 单包布局', () => {
  it('dist/tui/<platform>-<arch>/bin/zhishi-tui 存在则直接用它', () => {
    // 用 join 构造期望值：Windows 下 join 产出反斜杠，硬编码正斜杠会永远不等。
    const hit = join('/pkg', 'dist', 'tui', 'win32-x64', 'bin', 'zhishi-tui.exe');
    expect(
      resolveTuiBinary({
        env: {},
        platform: 'win32',
        arch: 'x64',
        selfPath: join('/pkg', 'dist', 'cli.js'),
        cwd: '/nonexistent-workdir',
        exists: (p) => p === hit,
        resolveFromPackage: () => {
          throw new Error('不该走到平台包');
        },
      }),
    ).toBe(hit);
  });

  it('单包目录不存在时继续回落平台包', () => {
    const packaged = join('/pkg', 'node_modules', '@lielingai', 'zhishi-tui-win32-x64', 'bin', 'zhishi-tui.exe');
    expect(
      resolveTuiBinary({
        env: {},
        platform: 'win32',
        arch: 'x64',
        selfPath: join('/pkg', 'dist', 'cli.js'),
        cwd: '/nonexistent-workdir',
        exists: (p) => p === packaged,
        resolveFromPackage: () => packaged,
      }),
    ).toBe(packaged);
  });
});
