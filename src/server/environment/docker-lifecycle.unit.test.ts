/**
 * 安全研究员版 P1 E4 — docker 环境生命周期 unit tests.
 *
 * 全部通过注入的 exec 断言命令组装与输出解析，绝不真调 docker。
 * 覆盖：镜像 tag / 容器名约定、build/run/stop/rm/ps/images 参数组装、
 * `docker ps` 输出解析（含 Windows 路径 workspace）、docker 不可用的
 * 清晰错误（复用 E1 探测语义）、VM 配方的内部路由错误拦截、build/run 失败路径、
 * 1.5.10 三层模型（envUp 四分支 / down 只 stop 不 rm / rebuild / reset /
 * 镜像发现解析）。
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from './recipes';
import {
  buildDockerBuildArgs,
  buildDockerImagesArgs,
  buildDockerPsAllArgs,
  buildDockerPsArgs,
  buildDockerPsByRecipeArgs,
  buildDockerRunArgs,
  containerNameFor,
  dockerContainerRunning,
  envDown,
  envImages,
  envPs,
  envPsAll,
  envRebuild,
  envReset,
  envRmContainer,
  envUp,
  imageTagFor,
  parseDockerImages,
  parseDockerPs,
  parseDockerPsAll,
  parseDockerRunningRows,
  recognizeDockerBuildNetworkFailure,
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

  it('run args: detached, labeled, workspace mounted at /workspace, first-run hook + keep-alive tail', () => {
    expect(buildDockerRunArgs(RECIPE, 'zhishi-web-recon-a1b2c3d4', '/work/dir')).toEqual([
      'run', '-d',
      '--name', 'zhishi-web-recon-a1b2c3d4',
      '--label', 'zhishi.env=web-recon',
      '--label', 'zhishi.workspace=/work/dir',
      '-v', '/work/dir:/workspace',
      '-w', '/workspace',
      'zhishi-env-web-recon',
      // 1.5.7 首跑钩子：脚本存在则 nohup 后台执行（不阻塞容器就绪），随后 exec tail 常驻
      'bash', '-c', 'if [ -f /opt/zhishi/first-run.sh ]; then nohup bash /opt/zhishi/first-run.sh >> /var/log/zhishi-first-run.log 2>&1 & fi; exec tail -f /dev/null',
    ]);
  });

  it('ps args filter by the zhishi.env label with a tab-separated format', () => {
    const args = buildDockerPsArgs();
    expect(args).toContain('--filter');
    expect(args).toContain('label=zhishi.env');
    expect(args[0]).toBe('ps');
  });

  it('1.5.10：buildDockerPsByRecipeArgs 含 -a（含已停止）且按配方 label 过滤', () => {
    const args = buildDockerPsByRecipeArgs('web-recon');
    expect(args[0]).toBe('ps');
    expect(args).toContain('-a');
    expect(args).toContain('label=zhishi.env=web-recon');
  });

  it('1.5.10：buildDockerImagesArgs 只认 zhishi-env-* 且过滤 dangling', () => {
    const args = buildDockerImagesArgs();
    expect(args[0]).toBe('images');
    expect(args).toContain('dangling=false');
    expect(args).toContain('reference=zhishi-env-*');
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

describe('envUp（1.5.10 链路重排：容器→镜像→build）', () => {
  const RUNNING_LINE =
    'd0e5f6a7b8c9\tzhishi-web-recon-a1b2c3d4\tzhishi-env-web-recon\tUp 2 hours\tweb-recon\t/work/dir';
  const STOPPED_LINE =
    'd0e5f6a7b8c9\tzhishi-web-recon-a1b2c3d4\tzhishi-env-web-recon\tExited (0) 3 days ago\tweb-recon\t/work/dir';
  const INSPECT_MISS = { exitCode: 1, stdout: '', stderr: 'Error: No such image' };
  const RUN_OK = ok('d0e5f6a7b8c9d0e5f6a7b8c9\n');

  it('分支 (c)：无容器无镜像 → ps -a → inspect miss → build → run', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(''), // ps -a：同配方无容器（含已停止）
      INSPECT_MISS, // image inspect：镜像不在
      ok('...build output...'),
      RUN_OK,
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
    expect(calls[1].slice(0, 2)).toEqual(['docker', 'ps']); // 1.5.10 容器查找
    expect(calls[1]).toContain('-a'); // 含已停止
    expect(calls[1]).toContain('label=zhishi.env=web-recon');
    expect(calls[2].slice(0, 3)).toEqual(['docker', 'image', 'inspect']);
    expect(calls[3].slice(0, 2)).toEqual(['docker', 'build']);
    expect(calls[4].slice(0, 2)).toEqual(['docker', 'run']);
  });

  it('分支 (a) 在跑幂等：同配方已有在跑容器 → 直接返回现有实例，不 build 不 run', async () => {
    const { exec, calls } = scriptedExec([PROBE_OK, ok(`${RUNNING_LINE}\n`)]);
    const result = await envUp(RECIPE, '/work/dir', { exec, shortId: () => 'ffffffff' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4');
    expect(result.instance.id).toBe('d0e5f6a7b8c9');
    // 只有 probe + ps，绝不发 build/run（不再泄漏孤儿容器）
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c[1] === 'build' || c[1] === 'run')).toBe(false);
  });

  it('分支 (a) 已停止 → docker start 现场续上（1.5.10 核心），不 build 不 run', async () => {
    const { exec, calls } = scriptedExec([PROBE_OK, ok(`${STOPPED_LINE}\n`), ok('d0e5f6a7b8c9\n')]);
    const result = await envUp(RECIPE, '/work/dir', { exec, shortId: () => 'ffffffff' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4');
    expect(result.instance.status).toBe('Up'); // start 后状态置 Up
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(['docker', 'start', 'd0e5f6a7b8c9']);
    expect(calls.some((c) => c[1] === 'build' || c[1] === 'run')).toBe(false);
  });

  it('start 失败（容器损坏）→ rm -f 清残壳后回落 build/run（现场丢失有日志）', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(`${STOPPED_LINE}\n`),
      { exitCode: 1, stdout: '', stderr: 'container is marked for removal' }, // start 失败
      ok(''), // rm -f 残壳
      INSPECT_MISS, // 镜像不在
      ok('built'),
      RUN_OK,
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec, shortId: () => 'a1b2c3d4' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4'); // 新容器
    expect(calls[3]).toEqual(['docker', 'rm', '-f', 'd0e5f6a7b8c9']);
    expect(calls.some((c) => c[1] === 'build')).toBe(true);
    expect(calls.some((c) => c[1] === 'run')).toBe(true);
  });

  it('分支 (b)：无容器有镜像 → 跳过 build 直接 run（秒开）', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(''), // ps -a：无容器
      ok('[{"Id":"sha256:..."}]'), // image inspect：镜像在
      RUN_OK,
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec, shortId: () => 'a1b2c3d4' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4');
    expect(calls).toHaveLength(4);
    expect(calls.some((c) => c[1] === 'build')).toBe(false); // 镜像在 → 不 build
    expect(calls[3].slice(0, 2)).toEqual(['docker', 'run']);
  });

  it('容器查找只认同配方：别的配方容器不挡本配方 up', async () => {
    const otherLine = 'aaaaaaaabbbb\tzhishi-pwn-12345678\tzhishi-env-pwn\tUp 1 hour\tpwn\t/other';
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(`${otherLine}\n`),
      INSPECT_MISS,
      ok('built'),
      RUN_OK,
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec, shortId: () => 'a1b2c3d4' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4');
    expect(calls.some((c) => c[1] === 'run')).toBe(true);
  });

  it('容器查找的 ps 失败 → 容忍，照走镜像/build 分支', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      { exitCode: 1, stdout: '', stderr: 'ps hiccup' },
      INSPECT_MISS,
      ok('built'),
      RUN_OK,
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec, shortId: () => 'a1b2c3d4' });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c[1] === 'build')).toBe(true);
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
      ok(''), // 容器查找：无容器
      INSPECT_MISS, // 镜像不在
      { exitCode: 1, stdout: '', stderr: 'no such file: Dockerfile' },
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('build');
    expect(result.error).toContain('no such file: Dockerfile');
  });

  it('build 失败命中网络形态识别 → 指引在前 + 原 stderr 尾部在后（1.5.7）', async () => {
    const { exec } = scriptedExec([
      PROBE_OK,
      ok(''), // 容器查找：无容器
      INSPECT_MISS,
      {
        exitCode: 1,
        stdout: '',
        stderr: '#5 ERROR: failed to fetch https://auth.docker.io/token: dial tcp: i/o timeout',
      },
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('registry-mirrors');
    expect(result.error).toContain('原始报错尾部');
    expect(result.error).toContain('auth.docker.io');
  });

  it('1.5.9 超时恢复：build 客户端超时但镜像已在 daemon 完成 → inspect 命中后续走 run', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(''), // 容器查找：无容器
      INSPECT_MISS, // 前置 inspect：镜像不在 → 走 build
      {
        exitCode: -1,
        stdout: '#14 naming to docker.io/library/zhishi-env-pwn:latest done\n#14 DONE 46.2s\n',
        stderr: '',
        error: 'timed out after 2700000ms: docker build -t zhishi-env-pwn .',
      },
      ok('[]'), // 超时恢复 inspect：镜像在 daemon 已完成
      RUN_OK,
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec, shortId: () => 'a1b2c3d4' });
    expect(result.ok).toBe(true);
    expect(calls[2].slice(0, 3)).toEqual(['docker', 'image', 'inspect']);
    expect(calls[3].slice(0, 2)).toEqual(['docker', 'build']);
    expect(calls[4].slice(0, 3)).toEqual(['docker', 'image', 'inspect']);
    expect(calls[5].slice(0, 2)).toEqual(['docker', 'run']);
  });

  it('1.5.9 超时恢复：build 超时且镜像不在（inspect 失败）→ 仍报失败', async () => {
    const { exec } = scriptedExec([
      PROBE_OK,
      ok(''),
      INSPECT_MISS,
      { exitCode: -1, stdout: '', stderr: '', error: 'timed out after 2700000ms: docker build ...' },
      { exitCode: 1, stdout: '', stderr: 'Error: No such image' },
    ]);
    const result = await envUp(RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('docker build 失败');
  });
});

describe('recognizeDockerBuildNetworkFailure（1.5.7 报错网络形态识别，纯函数）', () => {
  it('形态 2：docker.io dial/timeout → 指引配 daemon registry-mirrors（带 JSON 示例）', () => {
    const out = recognizeDockerBuildNetworkFailure(
      'ERROR: failed to solve: failed to fetch anonymous token: Get "https://auth.docker.io/token": dial tcp 54.236.131.166:443: i/o timeout',
    );
    expect(out).toBeDefined();
    expect(out).toContain('registry-mirrors');
    expect(out).toContain('"https://docker.m.daocloud.io"');
  });

  it('形态 1：已知镜像站域名 + EOF → 指出当前镜像站挂了并给替代清单', () => {
    const out = recognizeDockerBuildNetworkFailure(
      'ERROR: failed to solve: docker.m.daocloud.io/library/ubuntu:24.04: reading manifest: EOF',
    );
    expect(out).toBeDefined();
    expect(out).toContain('docker.m.daocloud.io');
    expect(out).toContain('镜像站');
    expect(out).toContain('dockerproxy.net');
  });

  it('形态 3：apt-get exit 100 + archive.ubuntu.com → 指引容器代理并说明配方已带 apt 回落', () => {
    const out = recognizeDockerBuildNetworkFailure(
      'Err:1 http://archive.ubuntu.com/ubuntu noble InRelease\nCould not connect to archive.ubuntu.com:80\nexecutor failed running [/bin/sh -c apt-get update]: exit code: 100',
    );
    expect(out).toBeDefined();
    expect(out).toContain('apt');
    expect(out).toContain('USTC');
    expect(out).toContain('代理');
  });

  it('形态 4：git clone github.com exit 128 → 说明配方已带 gh-proxy 回落或指引代理', () => {
    const out = recognizeDockerBuildNetworkFailure(
      "fatal: unable to access 'https://github.com/joernio/joern.git/': Failed to connect\nexecutor failed running [/bin/sh -c git clone ...]: exit code: 128",
    );
    expect(out).toBeDefined();
    expect(out).toContain('github.com');
    expect(out).toContain('gh-proxy');
  });

  it('形态 5：PyPI 索引不通（上游脚本内部 pip/uv，exit 1）→ 说明镜像重试 + 指引代理（1.5.8）', () => {
    // 实机形态：pwndbg setup.sh 内部 pip install uv 撞上 PyPI 不通
    const out = recognizeDockerBuildNetworkFailure(
      "Creating virtualenv in path: /opt/pwndbg/.venv\nERROR: Could not find a version that satisfies the requirement uv (from versions: none)\nERROR: No matching distribution found for uv\nexecutor failed running [/bin/sh -c ... ./setup.sh]: exit code: 1",
    );
    expect(out).toBeDefined();
    expect(out).toContain('PyPI');
    expect(out).toContain('清华镜像');
  });

  it('认不出的输出 → undefined（调用方原样输出 stderr 尾部）', () => {
    expect(recognizeDockerBuildNetworkFailure('no such file: Dockerfile')).toBeUndefined();
  });

  it('1.5.9 收紧：正常完成的 build 输出（naming/pull 行带 docker.io）+ exec 超时 → 不误报形态 2', () => {
    // 实机误报形态：BuildKit daemon 把构建跑完了（naming done），但客户端
    // 超时被杀——输出里全是 docker.io 正常行 + 错误是 exec 超时文案。
    const out = recognizeDockerBuildNetworkFailure(
      '#14 naming to docker.io/library/zhishi-env-pwn:latest done\n#14 DONE 46.2s\ntimed out after 2700000ms: docker build -t zhishi-env-pwn .',
    );
    expect(out).toBeUndefined();
  });
});

describe('envDown（1.5.10：只 stop 不 rm——现场持久）', () => {
  it('只发 docker stop，绝不 rm（容器保留现场）', async () => {
    const { exec, calls } = scriptedExec([ok('')]);
    const result = await envDown('d0e5f6a7b8c9', { exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopped).toBe('d0e5f6a7b8c9');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['docker', 'stop', 'd0e5f6a7b8c9']);
  });

  it('stop 未成功（已停止/已消失）→ 幂等放行（视为已暂停），不发 rm', async () => {
    const { exec, calls } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'No such container' },
    ]);
    const result = await envDown('gone', { exec });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('envRmContainer（1.5.10：rm 端点/重建/重置的真删除语义）', () => {
  it('stop（幂等）+ rm 容器', async () => {
    const { exec, calls } = scriptedExec([ok(''), ok('')]);
    const result = await envRmContainer('d0e5f6a7b8c9', { exec });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(['docker', 'stop', 'd0e5f6a7b8c9']);
    expect(calls[1]).toEqual(['docker', 'rm', 'd0e5f6a7b8c9']);
  });

  it('stop 失败（已停止）不阻断 rm；rm 失败才报错', async () => {
    const { exec, calls } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'No such container' },
      ok(''),
    ]);
    const result = await envRmContainer('gone', { exec });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);

    const fail = await envRmContainer('x', {
      exec: async (argv) =>
        argv[1] === 'rm'
          ? { exitCode: 1, stdout: '', stderr: 'permission denied' }
          : ok(''),
    });
    expect(fail.ok).toBe(false);
    if (fail.ok) return;
    expect(fail.error).toContain('permission denied');
  });
});

describe('envRebuild（1.5.10 显式重建：强制 build → 清旧容器 → run）', () => {
  const OLD_LINE =
    'd0e5f6a7b8c9\tzhishi-web-recon-old99\tzhishi-env-web-recon\tUp 2 hours\tweb-recon\t/work/dir';
  const RUN_OK = ok('f6e5d4c3b2a1f6e5d4c3b2a1\n');

  it('有旧容器 → 强制 build（不看镜像在不在）→ stop+rm 旧容器 → run 新容器', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('built'), // build 强制跑（无前置 inspect 短路）
      ok(`${OLD_LINE}\n`), // ps -a 找旧容器
      ok(''), // stop 旧容器
      ok(''), // rm 旧容器
      RUN_OK,
    ]);
    const result = await envRebuild(RECIPE, '/work/dir', { exec, shortId: () => 'a1b2c3d4' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4');
    expect(calls[1].slice(0, 2)).toEqual(['docker', 'build']); // 紧跟 probe，无 inspect
    expect(calls[3]).toEqual(['docker', 'stop', 'd0e5f6a7b8c9']);
    expect(calls[4]).toEqual(['docker', 'rm', 'd0e5f6a7b8c9']);
    expect(calls[5].slice(0, 2)).toEqual(['docker', 'run']);
  });

  it('无旧容器 → build 后直接 run', async () => {
    const { exec, calls } = scriptedExec([PROBE_OK, ok('built'), ok(''), RUN_OK]);
    const result = await envRebuild(RECIPE, '/work/dir', { exec, shortId: () => 'a1b2c3d4' });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c[1] === 'stop' || c[1] === 'rm')).toBe(false);
    expect(calls[3].slice(0, 2)).toEqual(['docker', 'run']);
  });

  it('build 失败 → 旧容器不动（不 stop 不 rm），报 build 错误', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      { exitCode: 1, stdout: '', stderr: 'no such file: Dockerfile' },
    ]);
    const result = await envRebuild(RECIPE, '/work/dir', { exec });
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c[1] === 'stop' || c[1] === 'rm' || c[1] === 'run')).toBe(false);
  });
});

describe('envReset（1.5.10 显式重置：镜像不动，换干净容器）', () => {
  const OLD_LINE =
    'd0e5f6a7b8c9\tzhishi-web-recon-old99\tzhishi-env-web-recon\tExited (0) 1 day ago\tweb-recon\t/work/dir';
  const RUN_OK = ok('f6e5d4c3b2a1f6e5d4c3b2a1\n');

  it('有容器 → stop+rm 旧容器 → run 新容器（workspace 取旧容器 label），不 build', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(`${OLD_LINE}\n`), // label 反查定位容器 + 取回 workspace
      ok(''), // stop
      ok(''), // rm
      RUN_OK,
    ]);
    const result = await envReset('web-recon', undefined, {
      exec,
      container: 'zhishi-web-recon-old99',
      shortId: () => 'a1b2c3d4',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-web-recon-a1b2c3d4');
    expect(result.instance.workspace).toBe('/work/dir'); // 现场挂载不变
    expect(calls[2]).toEqual(['docker', 'stop', 'zhishi-web-recon-old99']);
    expect(calls[3]).toEqual(['docker', 'rm', 'zhishi-web-recon-old99']);
    expect(calls.some((c) => c[1] === 'build')).toBe(false); // 镜像不动
  });

  it('无容器可 rm → 直接 run（幂等），workspace 回落 cwd', async () => {
    const { exec, calls } = scriptedExec([PROBE_OK, ok(''), RUN_OK]);
    const result = await envReset('web-recon', '/explicit/ws', {
      exec,
      shortId: () => 'a1b2c3d4',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.workspace).toBe('/explicit/ws');
    expect(calls).toHaveLength(3);
    expect(calls[2].slice(0, 2)).toEqual(['docker', 'run']);
  });
});

describe('1.5.10 镜像发现 — envImages / parseDockerImages', () => {
  const IMAGES =
    'zhishi-env-pwn:latest\n' +
    'zhishi-env-web-recon:latest\n' +
    'mysql:8\n' + // 非 zhishi-env-*（防御：daemon 侧已过滤，解析侧再守一道）
    '<none>:<none>\n';

  it('parseDockerImages 反解 recipeId；非 zhishi-env-* 与 dangling 不纳管', () => {
    const items = parseDockerImages(IMAGES);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      driver: 'docker-image',
      id: 'zhishi-env-pwn:latest',
      name: 'zhishi-env-pwn:latest',
      image: 'zhishi-env-pwn:latest',
      recipeId: 'pwn',
    });
    expect(items[1].recipeId).toBe('web-recon');
  });

  it('envImages 经注入 exec 返回镜像清单、只读；docker 不可用降级 ok:false', async () => {
    const { exec, calls } = scriptedExec([ok(IMAGES)]);
    const result = await envImages({ exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2).join(' ')).toBe('docker images');

    const down = await envImages({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
    });
    expect(down.ok).toBe(false);
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
