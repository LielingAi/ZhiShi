/**
 * 安全研究员版 P1 E4 — docker 环境配方生命周期.
 *
 * docker 配方 = Dockerfile + setup.sh + SKILL.md。生命周期命令：
 *
 *   envUp(recipe, workspace)
 *     0. 幂等：zhishi.env=<name> label 已有在跑容器 → 直接返回现有实例
 *     1. docker build -t zhishi-env-<name> <dir>
 *     2. docker run -d --name zhishi-<name>-<shortid>
 *       --label zhishi.env=<name> --label zhishi.workspace=<path>
 *       -v <workspace>:/workspace -w /workspace
 *       zhishi-env-<name> bash -c '<首跑钩子>; exec tail -f /dev/null'
 *                                        # 容器常驻，exec 进入；1.5.7 起首跑
 *                                        # 钩子（/opt/zhishi/first-run.sh，存在
 *                                        # 才跑）后台装 firstRunTools 声明的工具
 *   envDown(instanceId) → docker stop + docker rm
 *   envPs()             → docker ps --filter label=zhishi.env 解析成实例列表
 *
 * VM 配方（base: vm）不走这里——由 environment/vm-lifecycle.ts 的 vmrun
 * 驱动接管（P2）；本模块收到 VM 配方说明 admin-api 路由错了，报内部错误。
 * docker 不可用时报带安装引导的清晰错误（复用 E1 engines 探测的 probe
 * spec + guidance，见 engines.ts）。
 *
 * 结构照 `engines.ts`：命令组装与 `docker ps` 输出解析是纯函数；所有进程
 * 调用走可注入的 `DockerExec`，单测绝不真调 docker。
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { spawn as spawnSubprocess } from '../utils/subprocess';
import { ENGINE_SPECS, parseEngineProbeResult } from './engines';
import type { EnvironmentRecipe } from './recipes';

export type EnvResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** 一个由配方启动的容器实例。 */
export interface EnvInstance {
  /** 容器短 id（docker ps 的 12 位 / run 输出的前 12 位）。 */
  id: string;
  /** 容器名 zhishi-<recipe>-<shortid>。 */
  name: string;
  image: string;
  status: string;
  recipe: string;
  workspace: string;
}

export interface DockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Spawn-level error message (ENOENT etc.) when the process never ran. */
  error?: string;
}

export type DockerExec = (argv: string[], timeoutMs: number) => Promise<DockerExecResult>;

export interface LifecycleOptions {
  exec?: DockerExec;
  /** 实例名后缀；可注入以便测试。默认 8 位随机 hex。 */
  shortId?: () => string;
  /** build/run 输出落盘目录；缺省只走 console。 */
  logDir?: string;
}

// ---------------------------------------------------------------------------
// Pure functions — command assembly + output parsing
// ---------------------------------------------------------------------------

export function imageTagFor(recipeId: string): string {
  return `zhishi-env-${recipeId}`;
}

export function containerNameFor(recipeId: string, shortId: string): string {
  return `zhishi-${recipeId}-${shortId}`;
}

/** `docker build -t zhishi-env-<name> <dir>` */
export function buildDockerBuildArgs(recipe: EnvironmentRecipe): string[] {
  return ['build', '-t', imageTagFor(recipe.id), recipe.dir];
}

/**
 * `docker run -d --name zhishi-<name>-<shortid> --label ... -v ws:/workspace
 * -w /workspace <image> bash -c '<首跑钩子> ; exec tail -f /dev/null'`
 * ——容器常驻，后续 docker exec 进入。
 *
 * 1.5.7 首跑钩子：配方 firstRunTools 声明的重型工具（如 joern 1.8GB，下载
 * 20min 级）由镜像内 /opt/zhishi/first-run.sh 安装。钩子脚本存在则 nohup
 * 后台执行（日志落 /var/log/zhishi-first-run.log），**不阻塞容器就绪**——
 * env up 的 run 超时（DOCKER_RUN_TIMEOUT_MS = 60s）等不起首跑安装；nohup
 * 防止后续 exec 的信号链杀掉安装进程。脚本不存在（无首跑工具的配方）直接
 * 跳过，行为与旧版 `tail -f /dev/null` 完全一致。
 */
export function buildDockerRunArgs(
  recipe: EnvironmentRecipe,
  containerName: string,
  workspace: string,
): string[] {
  return [
    'run', '-d',
    '--name', containerName,
    '--label', `zhishi.env=${recipe.id}`,
    '--label', `zhishi.workspace=${workspace}`,
    '-v', `${workspace}:/workspace`,
    '-w', '/workspace',
    imageTagFor(recipe.id),
    'bash', '-c', 'if [ -f /opt/zhishi/first-run.sh ]; then nohup bash /opt/zhishi/first-run.sh >> /var/log/zhishi-first-run.log 2>&1 & fi; exec tail -f /dev/null',
  ];
}

/**
 * Tab-separated ps format：label 值逐字段取（`{{.Label "..."}}`），避免
 * `{{json .}}` 的 Labels 逗号串在 workspace 路径含逗号时错位。路径里
 * 制表符极罕见，可接受。
 */
export function buildDockerPsArgs(): string[] {
  return [
    'ps',
    '--filter', 'label=zhishi.env',
    '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Label "zhishi.env"}}\t{{.Label "zhishi.workspace"}}',
  ];
}

/** Parse `docker ps` tab-separated rows (see buildDockerPsArgs) into instances. */
export function parseDockerPs(stdout: string): EnvInstance[] {
  const instances: EnvInstance[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.replace(/\r$/, '').split('\t');
    if (cols.length < 6) continue; // malformed row — skip, don't fail the list
    const [id, name, image, status, recipe, workspace] = cols;
    instances.push({ id, name, image, status, recipe, workspace });
  }
  return instances;
}

// ---------------------------------------------------------------------------
// 1.5.7 — docker build 失败的网络形态识别（纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * 已知名可查的 registry 镜像站域名（daemon registry-mirrors 常用项）。
 * 构建报错里出现这些域名 + 连接中断类关键词，说明是「当前镜像站挂了」，
 * 与「Docker Hub 直连不通」是两种形态，指引不同（换站 vs 首配 mirror）。
 */
const KNOWN_REGISTRY_MIRROR_HOSTS: readonly string[] = [
  'docker.m.daocloud.io',
  'dockerproxy',
  'docker.nju.edu.cn',
  'hub-mirror.c.163.com',
  'mirror.ccs.tencentyun.com',
  'registry.docker-cn.com',
  'docker.mirrors.ustc.edu.cn',
];

/** 可选的替代镜像站清单（指引文案共用）。 */
const REGISTRY_MIRROR_SUGGESTIONS = [
  'https://docker.m.daocloud.io',
  'https://dockerproxy.net',
  'https://docker.nju.edu.cn',
];

/**
 * 识别 docker build 失败输出的网络形态，返回用户可读的排查指引；
 * 认不出来返回 undefined（调用方原样输出 stderr 尾部）。
 *
 * 五种形态（按优先级）：
 *   1. 已知镜像站域名 + EOF/timeout —— 当前镜像站挂了/限流，给替代清单；
 *   2. auth.docker.io / docker.io + dial/timeout —— Docker Hub 直连不通，
 *      指引配 daemon registry-mirrors（带 JSON 示例）；
 *   3. apt-get exit 100 / archive.ubuntu.com —— 容器内 apt 源不通；1.5.7
 *      配方已内置 apt 源回落，仍失败则指引容器代理；
 *   4. git exit 128 / github.com —— 容器内 git 拉取不通；1.5.7 配方已内置
 *      gh-proxy 回落，仍失败则指引构建代理；
 *   5. PyPI 索引不通（1.5.8：from versions: none / No matching distribution
 *      ——上游脚本内部 pip/uv 调用形态，如实机 pwndbg setup.sh 装 uv）——
 *      1.5.8 配方已内置镜像环境变量重试，仍失败则指引构建代理。
 */
export function recognizeDockerBuildNetworkFailure(output: string): string | undefined {
  const text = output.toLowerCase();
  const hasNetError = /(dial tcp|i\/o timeout|timed out|timeout|eof|connection reset|no such host|temporary failure|unavailable)/.test(text);

  // 形态 1：已知镜像站 + 连接中断 —— 镜像站自身故障/限流。
  const mirror = KNOWN_REGISTRY_MIRROR_HOSTS.find((h) => text.includes(h));
  if (mirror && hasNetError) {
    return [
      `网络形态识别：当前配置的 registry 镜像站（${mirror}）连接中断/超时——该镜像站可能已挂或限流。`,
      '可在 daemon 配置（registry-mirrors）中替换为其他镜像站：',
      ...REGISTRY_MIRROR_SUGGESTIONS.map((m) => `  - ${m}`),
      '改完重启 docker（Linux: systemctl restart docker；Docker Desktop: 重启应用）后重试。',
    ].join('\n');
  }

  // 形态 2：Docker Hub 直连失败 —— 需要首配 registry-mirrors。
  if (
    /(auth\.docker\.io|registry-1\.docker\.io|docker\.io)/.test(text) &&
    /(dial tcp|i\/o timeout|timed out|no such host|connection refused)/.test(text)
  ) {
    return [
      '网络形态识别：Docker Hub 直连失败（docker.io 拨号超时/不可达）——国内网络通常需要配置 registry 镜像站。',
      '在 docker daemon 配置（Linux: /etc/docker/daemon.json；Docker Desktop: Settings → Docker Engine）加入：',
      '{',
      '  "registry-mirrors": [',
      ...REGISTRY_MIRROR_SUGGESTIONS.map((m, i) => `    "${m}"${i < REGISTRY_MIRROR_SUGGESTIONS.length - 1 ? ',' : ''}`),
      '  ]',
      '}',
      '保存后重启 docker 再重试。',
    ].join('\n');
  }

  // 形态 3：容器内 apt 失败（exit 100 / ubuntu 官方源不可达）。
  if (
    /(exit code: 100|exit status 100)/.test(text) &&
    /(apt|archive\.ubuntu\.com|security\.ubuntu\.com)/.test(text)
  ) {
    return [
      '网络形态识别：容器内 apt 更新/安装失败（exit 100，ubuntu 官方源不可达）。',
      '1.5.7 配方已内置 apt 源回落（默认源不通自动切 USTC 镜像）；若仍失败，说明镜像内全部 apt 源不可达，',
      '请为容器构建/运行配置网络代理（Docker Desktop: Settings → Resources → Proxies；或 daemon 的 http-proxy 配置）后重试。',
    ].join('\n');
  }

  // 形态 4：容器内 git 访问 github.com 失败（exit 128）。
  if (/(exit code: 128|exit status 128)/.test(text) && text.includes('github.com')) {
    return [
      '网络形态识别：容器内 git 访问 github.com 失败（exit 128）。',
      '1.5.7 配方已内置 gh-proxy 回落；若仍失败，请为容器构建配置代理',
      '（docker build --build-arg HTTPS_PROXY=...，或 Docker Desktop / daemon 代理设置）后重试。',
    ].join('\n');
  }

  // 形态 5：PyPI 索引不通（上游脚本内部 pip/uv 调用——1.5.8 实机形态）。
  if (
    /(no matching distribution found|from versions: none|could not find a version that satisfies)/.test(text)
  ) {
    return [
      '网络形态识别：容器内 pip/uv 找不到任何可用版本——PyPI 索引不可达（不是包不存在）。',
      '1.5.8 配方已内置镜像环境变量重试（清华镜像）；若仍失败，请为容器构建配置代理',
      '（docker build --build-arg HTTPS_PROXY=...，或 Docker Desktop / daemon 代理设置）后重试。',
    ].join('\n');
  }

  return undefined;
}


/**
 * D28 自动发现：全量 `docker ps -a`（含已退出），**去掉** `label=zhishi.env`
 * 过滤——把宿主机所有容器都暴露给 gate 的「本机已有」分组。每行多带一个
 * `managed` 标记（`zhishi.env` label 是否存在），便于 gate 去重已注册项。
 */
export function buildDockerPsAllArgs(): string[] {
  return [
    'ps',
    '-a',
    '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Label "zhishi.env"}}',
  ];
}

/** 自动发现用的 docker 容器条目（比 EnvInstance 多一个 managed 标记）。 */
export interface DiscoveredDocker {
  id: string;
  name: string;
  image: string;
  status: string;
  /** 是否由 zhishi 自己管理（带 zhishi.env label）。 */
  managed: boolean;
}

/** Parse `docker ps -a` tab-separated rows (see buildDockerPsAllArgs). */
export function parseDockerPsAll(stdout: string): DiscoveredDocker[] {
  const items: DiscoveredDocker[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.replace(/\r$/, '').split('\t');
    if (cols.length < 5) continue; // malformed row — skip, don't fail the list
    const [id, name, image, status, zhishiEnv] = cols;
    items.push({
      id,
      name,
      image,
      status,
      managed: !!zhishiEnv && zhishiEnv.length > 0,
    });
  }
  return items;
}

/**
 * 自动发现用的 docker 全量扫描（D28）。复用 EnvResult 契约，docker 不可用时
 * 返回 ok:false 由聚合层降级，绝不抛错。只读，不写配置。
 */
export async function envPsAll(
  options: LifecycleOptions = {},
): Promise<EnvResult<{ instances: DiscoveredDocker[] }>> {
  const exec = options.exec ?? defaultDockerExec;
  const result = await exec(['docker', ...buildDockerPsAllArgs()], DOCKER_PS_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `docker ps -a 失败（Docker 不可用？）：\n${outputTail(result)}`,
    };
  }
  return { ok: true, instances: parseDockerPsAll(result.stdout) };
}

// ---------------------------------------------------------------------------
// I/O — default exec (same shape as engines.ts::defaultEngineExec)
// ---------------------------------------------------------------------------

/** docker build can pull base images on first run — generous timeout. */
export const DOCKER_BUILD_TIMEOUT_MS = 15 * 60_000;
export const DOCKER_RUN_TIMEOUT_MS = 60_000;
export const DOCKER_PROBE_TIMEOUT_MS = 10_000;
export const DOCKER_PS_TIMEOUT_MS = 15_000;

async function defaultDockerExec(argv: string[], timeoutMs: number): Promise<DockerExecResult> {
  const proc = spawnSubprocess([resolveCommand(argv[0]), ...argv.slice(1)], {
    env: augmentedProcessEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (timedOut) {
      return { exitCode: -1, stdout, stderr, error: `timed out after ${timeoutMs}ms: ${argv.join(' ')}` };
    }
    if (proc.error) {
      return { exitCode, stdout, stderr, error: proc.error.message };
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle operations (exec-injectable)
// ---------------------------------------------------------------------------

/** Tail of build/run output for error messages (bounded, last non-empty lines). */
function outputTail(result: DockerExecResult, maxLines = 5): string {
  const text = (result.stderr || result.stdout || '').trim();
  if (!text) return result.error ?? '';
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(-maxLines).join('\n');
}

/** Persist build/run output when a logDir is configured; always console-log a line. */
function appendLog(logDir: string | undefined, fileName: string, content: string): void {
  if (!logDir) return;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, fileName), content);
  } catch (err) {
    console.warn(`[env-lifecycle] failed to write log ${fileName}:`, err);
  }
}

/**
 * docker 可用性前置检查：复用 E1 的 docker probe spec（`docker info`）+
 * guidance，exec 注入化。返回 null = 可用，否则为用户可读的引导错误。
 */
async function ensureDockerAvailable(exec: DockerExec): Promise<string | null> {
  const spec = ENGINE_SPECS.find((s) => s.kind === 'docker');
  if (!spec) return null;
  let probe: DockerExecResult;
  try {
    probe = await exec(spec.argv, DOCKER_PROBE_TIMEOUT_MS);
  } catch (err) {
    probe = { exitCode: -1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
  const status = parseEngineProbeResult(spec, probe);
  if (status.available) return null;
  return [status.guidance, status.detail].filter(Boolean).join(' — ');
}

/**
 * envUp：build 镜像 + 起常驻容器。VM 配方直接报内部路由错误（不碰 docker，
 * VM 由 vm-lifecycle.ts 接管）；
 * docker 不可用报带引导的错误；build/run 输出落日志（logDir 配置时）。
 */
export async function envUp(
  recipe: EnvironmentRecipe,
  workspace: string,
  options: LifecycleOptions = {},
): Promise<EnvResult<{ instance: EnvInstance }>> {
  if (recipe.base === 'vm') {
    return {
      ok: false,
      error: `内部路由错误：VM 配方 "${recipe.id}" 应由 vm-lifecycle（vmrun 驱动）处理，请反馈此问题`,
    };
  }

  const exec = options.exec ?? defaultDockerExec;

  const dockerError = await ensureDockerAvailable(exec);
  if (dockerError) return { ok: false, error: dockerError };

  // 1.3.8 B6 幂等：同配方已有在跑容器（zhishi.env=<recipe> label）→ 直接
  // 返回现有实例，不重复 build/run——重复 up 不再泄漏孤儿容器。ps 失败
  // （docker 抖动）容忍，照走正常 up。
  const psResult = await exec(['docker', ...buildDockerPsArgs()], DOCKER_PS_TIMEOUT_MS);
  if (psResult.exitCode === 0 && !psResult.error) {
    const existing = parseDockerPs(psResult.stdout).find((i) => i.recipe === recipe.id);
    if (existing) return { ok: true, instance: existing };
  }

  const buildArgs = buildDockerBuildArgs(recipe);
  const buildResult = await exec(['docker', ...buildArgs], DOCKER_BUILD_TIMEOUT_MS);
  appendLog(
    options.logDir,
    `${recipe.id}-build.log`,
    `$ docker ${buildArgs.join(' ')}\n${buildResult.stdout}${buildResult.stderr}\n`,
  );
  if (buildResult.exitCode !== 0 || buildResult.error) {
    // 1.5.7：先跑网络形态识别（对完整输出匹配，不受 outputTail 截断影响），
    // 命中则指引在前、原 stderr 尾部在后；认不出则原样输出尾部。
    const networkHint = recognizeDockerBuildNetworkFailure(
      `${buildResult.stdout}\n${buildResult.stderr}\n${buildResult.error ?? ''}`,
    );
    const detail = networkHint
      ? `${networkHint}\n--- 原始报错尾部 ---\n${outputTail(buildResult)}`
      : outputTail(buildResult);
    return {
      ok: false,
      error: `docker build 失败（配方 "${recipe.id}"）：\n${detail}`,
    };
  }

  const shortId = (options.shortId ?? (() => randomBytes(4).toString('hex')))();
  const containerName = containerNameFor(recipe.id, shortId);
  const runArgs = buildDockerRunArgs(recipe, containerName, workspace);
  const runResult = await exec(['docker', ...runArgs], DOCKER_RUN_TIMEOUT_MS);
  appendLog(
    options.logDir,
    `${containerName}-run.log`,
    `$ docker ${runArgs.join(' ')}\n${runResult.stdout}${runResult.stderr}\n`,
  );
  if (runResult.exitCode !== 0 || runResult.error) {
    return {
      ok: false,
      error: `docker run 失败（配方 "${recipe.id}"）：\n${outputTail(runResult)}`,
    };
  }

  const containerId = runResult.stdout.trim().slice(0, 12);
  return {
    ok: true,
    instance: {
      id: containerId,
      name: containerName,
      image: imageTagFor(recipe.id),
      status: 'Up',
      recipe: recipe.id,
      workspace,
    },
  };
}

/** envDown：stop + rm。stop 失败（已停止/已消失）不阻断 rm。 */
export async function envDown(
  instanceId: string,
  options: LifecycleOptions = {},
): Promise<EnvResult<{ removed: string }>> {
  const exec = options.exec ?? defaultDockerExec;

  const stopResult = await exec(['docker', 'stop', instanceId], DOCKER_RUN_TIMEOUT_MS);
  if (stopResult.exitCode !== 0) {
    console.warn(`[env-lifecycle] docker stop ${instanceId} failed (continuing to rm): ${outputTail(stopResult)}`);
  }

  const rmResult = await exec(['docker', 'rm', instanceId], DOCKER_RUN_TIMEOUT_MS);
  if (rmResult.exitCode !== 0 || rmResult.error) {
    return {
      ok: false,
      error: `docker rm 失败（实例 "${instanceId}"）：\n${outputTail(rmResult)}`,
    };
  }
  return { ok: true, removed: instanceId };
}

/**
 * 单容器运行探测（environment/rm 的 docker 分支前置）：`docker ps`（不带
 * -a，只有运行中名单）按 `{{.ID}}\t{{.Names}}` 取行，名字精确命中或短 id
 * 互为前缀即算在跑。docker 不可用 → ok:false，口径由调用方定（rm 照 vm
 * 「运行中拒绝」语义：探测失败视为不在跑，放行摘登记）。
 */
export function buildDockerPsNamesArgs(): string[] {
  return ['ps', '--format', '{{.ID}}\t{{.Names}}'];
}

/** docker ps（{{.ID}}\t{{.Names}}）行里 container 是否在跑（纯函数）。 */
export function parseDockerRunningRows(stdout: string, container: string): boolean {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.replace(/\r$/, '').split('\t');
    const [id, name] = cols;
    if (name === container) return true;
    if (id && (id.startsWith(container) || container.startsWith(id))) return true;
  }
  return false;
}

/** envPs 的单容器版：只答「这个容器在不在跑」。 */
export async function dockerContainerRunning(
  container: string,
  options: LifecycleOptions = {},
): Promise<EnvResult<{ running: boolean }>> {
  const exec = options.exec ?? defaultDockerExec;
  const result = await exec(['docker', ...buildDockerPsNamesArgs()], DOCKER_PS_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `docker ps 失败（Docker 不可用？）：\n${outputTail(result)}`,
    };
  }
  return { ok: true, running: parseDockerRunningRows(result.stdout, container) };
}

/** envPs：列出所有带 zhishi.env label 的运行中实例。 */
export async function envPs(
  options: LifecycleOptions = {},
): Promise<EnvResult<{ instances: EnvInstance[] }>> {
  const exec = options.exec ?? defaultDockerExec;
  const args = buildDockerPsArgs();
  const result = await exec(['docker', ...args], DOCKER_PS_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `docker ps 失败（Docker 不可用？）：\n${outputTail(result)}`,
    };
  }
  return { ok: true, instances: parseDockerPs(result.stdout) };
}
