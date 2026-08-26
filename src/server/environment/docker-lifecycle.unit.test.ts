/**
 * 安全研究员版 P1 E4 — docker 环境生命周期 unit tests.
 *
 * 全部通过注入的 exec 断言命令组装与输出解析，绝不真调 docker。
 * 覆盖：镜像 tag / 容器名约定、build/run/stop/rm/ps 参数组装、
 * `docker ps` 输出解析（含 Windows 路径 workspace）、docker 不可用的
 * 清晰错误（复用 E1 探测语义）、VM 配方的内部路由错误拦截、build/run 失败路径。
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from './recipes';
import {
  buildDockerBuildArgs,
  buildDockerPsAllArgs,
  buildDockerPsArgs,
  buildDockerRunArgs,
  containerNameFor,
  dockerContainerRunning,
  envDown,
  envPs,
  envPsAll,
  envUp,
  imageTagFor,
  parseDockerPs,
  parseDockerPsAll,
  parseDockerRunningRows,
  type DockerExec,
  type DockerExecResult,
} from './docker-lifecycle';

const RECIPE: EnvironmentRecipe = {
  id: 'web-recon',
  dir: '/recipes/web-recon',
  name: 'web-recon',
  description: 'Web 侦察研究现场',
  base: 'docker',
  tools: ['nmap'],
  valid: true,
  invalidReasons: [],
};

const VM_RECIPE: EnvironmentRecipe = { ...RECIPE, id: 'win-range', base: 'vm' };

function ok(stdout = ''): DockerExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

/** Scriptable exec: records argv, replays queued results in order. */
function scriptedExec(queue: Array<DockerExecResult | ((argv: string[]) => DockerExecResult)>) {
  const calls: string[][] = [];
  const exec: DockerExec = async (argv) => {
    calls.push(argv);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected exec: ${argv.join(' ')}`);
    return typeof next === 'function' ? next(argv) : next;
  };
  return { exec, calls };
}

/** Queue head = successful docker probe. */
const PROBE_OK = ok('27.1.1\n');

describe('command assembly (pure)', () => {
  it('image/container naming follows the zhishi-env / zhishi- convention', () => {
    expect(imageTagFor('web-recon')).toBe('zhishi-env-web-recon');
    expect(containerNameFor('web-recon', 'a1b2c3d4')).toBe('zhishi-web-recon-a1b2c3d4');
  });

  it('build args: docker build -t zhishi-env-<name> <dir>', () => {
    expect(buildDockerBuildArgs(RECIPE)).toEqual([
      'build', '-t', 'zhishi-env-web-recon', '/recipes/web-recon',
    ]);
  });

  it('run args: detached, labeled, workspace mounted at /workspace, keep-alive tail', () => {
    expect(buildDockerRunArgs(RECIPE, 'zhishi-web-recon-a1b2c3d4', '/work/dir')).toEqual([
      'run', '-d',
      '--name', 'zhishi-web-recon-a1b2c3d4',
      '--label', 'zhishi.env=web-recon',
      '--label', 'zhishi.workspace=/work/dir',
      '-v', '/work/dir:/workspace',
      '-w', '/workspace',
      'zhishi-env-web-recon',
      'tail', '-f', '/dev/null',
    ]);
  });

  it('ps args filter by the zhishi.env label with a tab-separated format', () => {
    const args = buildDockerPsArgs();
    expect(args).toContain('--filter');
    expect(args).toContain('label=zhishi.env');
    expect(args[0]).toBe('ps');
  });
});

describe('parseDockerPs (pure)', () => {
  const PS_LINE =
    'd0e5f6a7b8c9\tzhishi-web-recon-a1b2c3d4\tzhishi-env-web-recon\tUp 2 hours\tweb-recon\tE:\\code\\target app';

  it('parses tab-separated rows into instances (Windows paths keep colons/backslashes)', () => {
    const instances = parseDockerPs(`${PS_LINE}\n`);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toEqual({
      id: 'd0e5f6a7b8c9',
      name: 'zhishi-web-recon-a1b2c3d4',
      image: 'zhishi-env-web-recon',
      status: 'Up 2 hours',
      recipe: 'web-recon',
      workspace: 'E:\\code\\target app',
    });
  });

  it('handles empty output and skips malformed lines', () => {
    expect(parseDockerPs('')).toEqual([]);
    expect(parseDockerPs('\n\n')).toEqual([]);
    expect(parseDockerPs('garbage\n' + PS_LINE)).toHaveLength(1);
  });
});

describe('envUp', () => {
  it('runs probe → build → run and returns the started instance', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('...build output...'),
      ok('d0e5f6a7b8c9d0e5f6a7b8c9\n'),
    ]);
    const result = await envUp(RECIPE, '/work/dir', {
      exec,
      shortId: () => 'a1b2c3d4',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4');
    expect(result.instance.id).toBe('d0e5f6a7b8c9');
    expect(result.instance.recipe).toBe('web-recon');
    expect(result.instance.workspace).toBe('/work/dir');
    expect(calls[0][0]).toBe('docker');
    expect(calls[1].slice(0, 2)).toEqual(['docker', 'build']);
    expect(calls[2].slice(0, 2)).toEqual(['docker', 'run']);
  });

  it('rejects vm recipes as an internal routing error before touching docker', async () => {
    const { exec, calls } = scriptedExec([]);
    const result = await envUp(VM_RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('内部路由错误');
    expect(calls).toHaveLength(0);
  });

  it('fails with install guidance when docker is unavailable', async () => {
    const { exec, calls } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Docker');
    expect(result.error).toContain('Cannot connect to the Docker daemon');
    expect(calls).toHaveLength(1); // never reaches build
  });

  it('surfaces build failure output', async () => {
    const { exec } = scriptedExec([
      PROBE_OK,
      { exitCode: 1, stdout: '', stderr: 'no such file: Dockerfile' },
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('build');
    expect(result.error).toContain('no such file: Dockerfile');
  });

  it('surfaces run failure output', async () => {
    const { exec } = scriptedExec([
      PROBE_OK,
      ok('built'),
      { exitCode: 125, stdout: '', stderr: 'docker: Error response from daemon: Conflict.' },
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('run');
  });
});

describe('envDown', () => {
  it('stops then removes the container', async () => {
    const { exec, calls } = scriptedExec([ok(''), ok('')]);
    const result = await envDown('d0e5f6a7b8c9', { exec });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(['docker', 'stop', 'd0e5f6a7b8c9']);
    expect(calls[1]).toEqual(['docker', 'rm', 'd0e5f6a7b8c9']);
  });

  it('tolerates stop failure (already stopped) but still removes', async () => {
    const { exec, calls } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'No such container' },
      ok(''),
    ]);
    const result = await envDown('gone', { exec });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('fails when rm fails', async () => {
    const { exec } = scriptedExec([
      ok(''),
      { exitCode: 1, stdout: '', stderr: 'permission denied' },
    ]);
    const result = await envDown('x', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('permission denied');
  });
});

describe('envPs', () => {
  it('returns parsed instances', async () => {
    const { exec } = scriptedExec([
      ok('d0e5f6a7b8c9\tzhishi-web-recon-a1b2\tzhishi-env-web-recon\tUp 5 minutes\tweb-recon\t/w\n'),
    ]);
    const result = await envPs({ exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0].recipe).toBe('web-recon');
  });

  it('wraps docker failure in a clear error', async () => {
    const { exec } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
    ]);
    const result = await envPs({ exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Docker');
  });
});

describe('D28 自动发现 — envPsAll / parseDockerPsAll（全量含已退出）', () => {
  const PS_ALL =
    'd0e5f6a7b8c9\tweb-recon\tzhishi-env-web-recon\tUp 5 minutes\tweb-recon\n' +
    'a1b2c3d4e5f6\tstale-db\tpostgres:16\tExited (0) 2 hours ago\t\n' +
    'f6e5d4c3b2a1\tbuild-cache\talpine\tCreated\t\n';

  it('buildDockerPsAllArgs 去掉 label 过滤并含 -a', () => {
    const args = buildDockerPsAllArgs();
    expect(args).toContain('-a');
    expect(args.join(' ')).not.toContain('label=zhishi.env');
    expect(args.join(' ')).not.toContain('--filter');
  });

  it('parseDockerPsAll 解析全量（含已退出/未运行）并标记 managed', () => {
    const items = parseDockerPsAll(PS_ALL);
    expect(items).toHaveLength(3);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName['web-recon'].managed).toBe(true); // 带 zhishi.env label
    expect(byName['stale-db'].managed).toBe(false); // 空 label
    expect(byName['build-cache'].managed).toBe(false);
    expect(byName['stale-db'].status).toContain('Exited');
  });

  it('envPsAll 经注入 exec 返回全量、且只读不写配置', async () => {
    const { exec, calls } = scriptedExec([ok(PS_ALL)]);
    const result = await envPsAll({ exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instances).toHaveLength(3);
    // 只读：只发一次 `docker ps -a`，不发 docker run/rm 等写命令
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2).join(' ')).toBe('docker ps');
    expect(calls[0]).toContain('-a');
  });

  it('envPsAll 在 docker 不可用时降级为 ok:false（聚合层据此返回空数组）', async () => {
    const { exec } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
    ]);
    const result = await envPsAll({ exec });
    expect(result.ok).toBe(false);
  });
});

describe('dockerContainerRunning（environment/rm 前置的单容器运行探测）', () => {
  const PS_NAMES =
    'd0e5f6a7b8c9\tzhishi-pwn-a3f2\n' +
    'a1b2c3d4e5f6\tpostgres\n';

  it('parseDockerRunningRows：名字精确命中 / 短 id 互为前缀 / 不命中', () => {
    expect(parseDockerRunningRows(PS_NAMES, 'zhishi-pwn-a3f2')).toBe(true);
    expect(parseDockerRunningRows(PS_NAMES, 'd0e5f6a7b8c9')).toBe(true); // 完整短 id
    expect(parseDockerRunningRows(PS_NAMES, 'd0e5')).toBe(true); // id 前缀
    expect(parseDockerRunningRows(PS_NAMES, 'zhishi-pwn')).toBe(false); // 名字前缀不算
    expect(parseDockerRunningRows('', 'zhishi-pwn-a3f2')).toBe(false);
  });

  it('dockerContainerRunning：不带 -a（只查运行中），命中返回 running:true', async () => {
    const { exec, calls } = scriptedExec([ok(PS_NAMES)]);
    const result = await dockerContainerRunning('postgres', { exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.running).toBe(true);
    expect(calls[0].slice(0, 2).join(' ')).toBe('docker ps');
    expect(calls[0]).not.toContain('-a');
  });

  it('dockerContainerRunning：未命中 → running:false；docker 不可用 → ok:false', async () => {
    const miss = await dockerContainerRunning('ghost', { exec: async () => ok('') });
    expect(miss).toEqual({ ok: true, running: false });
    const down = await dockerContainerRunning('ghost', {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
    });
    expect(down.ok).toBe(false);
  });
});
