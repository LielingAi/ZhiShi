/**
 * 安全研究员版 P1 E4 — docker 环境配方生命周期.
 *
 * docker 配方 = Dockerfile + setup.sh + SKILL.md。生命周期命令：
 *
 * 1.5.10 三层模型（定稿）：镜像持久（本机已有可发现可启动）→ 容器持久
 * （现场，stop/start——/tmp crash 现场、装过的工具是研究资产）→ /workspace
 * 持久（成果，bind mount 不变）。不再是「用完即弃的一次性容器」。
 *
 *   envUp(recipe, workspace)——链路重排（1.5.10）：
 *     a. docker ps -a --filter label=zhishi.env=<name>（含已停止）找同配方容器：
 *        在跑 → 直接返回现有实例（幂等）；已停止 → docker start 现场续上
 *       （start 失败 = 容器损坏 → 清残壳后回落 build/run，原现场丢失）
 *     b. 无容器 → docker image inspect zhishi-env-<name>：镜像在 → 直接 run
 *       （跳过 build，秒开）
 *     c. 镜像不在 → docker build -t zhishi-env-<name> <dir> → run
 *     run 形态：docker run -d --name zhishi-<name>-<shortid>
 *       --label zhishi.env=<name> --label zhishi.workspace=<path>
 *       -v <workspace>:/workspace -w /workspace
 *       zhishi-env-<name> bash -c '<首跑钩子>; exec tail -f /dev/null'
 *                                        # 容器常驻，exec 进入；1.5.7 起首跑
 *                                        # 钩子（/opt/zhishi/first-run.sh，存在
 *                                        # 才跑）后台装 firstRunTools 声明的工具
 *   envDown(instanceId)      → docker stop（1.5.10：只暂停不 rm，现场持久；
 *                              真删除归 envRmContainer / envReset / envRebuild）
 *   envRmContainer(id)       → stop（幂等）+ rm——rm 端点的真删除语义
 *   envRebuild(recipe, ws)   → 强制 build（不看镜像在不在）→ stop+rm 旧容器
 *                              → run 新容器（显式重建入口）
 *   envReset(recipeId, ...)  → stop+rm 条目容器 → run 新容器（镜像不动，
 *                              要干净房间时的显式入口）
 *   envPs()                  → docker ps --filter label=zhishi.env 解析成实例列表
 *   envImages()              → docker images zhishi-env-* 镜像发现（1.5.10，
 *                              非 zhishi-env-* 不纳管——记录在案边界）
 *   envRemoveImage(image)    → docker rmi（1.6.3 #8 镜像删除；安全闸在 admin 层）
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
  /**
   * 1.5.10：fresh=true 跳过「已停止容器 start 续现场」分支——镜像行
   * 「启动为环境」的语义是从镜像**派生新容器**（老容器现场不动，
   * 留在 ps -a 里可手动续）；环境条目的启动（startEnv）不传——续现场。
   */
  fresh?: boolean;
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
  recipe: Pick<EnvironmentRecipe, 'id'>,
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

/**
 * 1.5.10：envUp/rebuild/reset 的同配方容器查找——`docker ps -a --filter
 * label=zhishi.env=<recipe>`（**含已停止**：现场持久的容器停着也要找到，
 * envUp 对它走 docker start 续现场）。输出格式与 buildDockerPsArgs 相同，
 * 解析复用 parseDockerPs。
 */
export function buildDockerPsByRecipeArgs(recipeId: string): string[] {
  return [
    'ps',
    '-a',
    '--filter', `label=zhishi.env=${recipeId}`,
    '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Label "zhishi.env"}}\t{{.Label "zhishi.workspace"}}',
  ];
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
 *   2. 真实拉取失败短语（oauth token / source metadata / pull 报错）+
 *      连接错误 —— Docker Hub 直连不通，指引配 daemon registry-mirrors
 *      （带 JSON 示例）；1.5.9 收紧——裸 docker.io+timeout 会误伤
 *      （正常 naming/pull 行都带 docker.io）；
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
  // 1.5.9 收紧：要求真实拉取失败短语（oauth token / source metadata / pull
  // 报错）——裸「docker.io + timeout」会误伤：正常输出里 naming/pull 行都带
  // docker.io，而 exec 超时文案带 timed out（实机误报：build 其实在 daemon
  // 里跑完了，镜像明明出来了）。
  if (
    /(failed to fetch [^\n]*token|failed to resolve source metadata|error pulling image|pull access denied|toomanyrequests)/.test(text) &&
    /(dial tcp|i\/o timeout|timed out|no such host|connection refused|eof|timeout)/.test(text)
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
// 1.5.10 — 镜像发现（「本机已有」接入镜像：镜像是发现面一等成员）
// ---------------------------------------------------------------------------

/**
 * `docker images` 枚举 zhishi-env-* 镜像。dangling=false 过滤构建残留的
 * `<none>:<none>` 层；reference 过滤在 daemon 侧收敛，解析侧再守一道
 * （非 zhishi-env-* 镜像不纳管——记录在案边界，见 roadmap 1.5.10）。
 */
export function buildDockerImagesArgs(): string[] {
  return [
    'images',
    '--filter', 'dangling=false',
    '--filter', 'reference=zhishi-env-*',
    '--format', '{{.Repository}}:{{.Tag}}',
  ];
}

/** 自动发现用的 docker 镜像条目（1.5.10 发现面新驱动 docker-image）。 */
export interface DiscoveredDockerImage {
  driver: 'docker-image';
  /** 镜像全名 zhishi-env-<recipe>:<tag>（唯一键）。 */
  id: string;
  name: string;
  image: string;
  /** 从仓库名反解的配方 id（zhishi-env-<recipeId> → recipeId）。 */
  recipeId: string;
}

/** Parse `docker images` 的 `{{.Repository}}:{{.Tag}}` 行（见 buildDockerImagesArgs）。 */
export function parseDockerImages(stdout: string): DiscoveredDockerImage[] {
  const items: DiscoveredDockerImage[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.replace(/\r$/, '').trim();
    if (!text) continue;
    const sep = text.lastIndexOf(':');
    const repo = sep > 0 ? text.slice(0, sep) : text;
    if (repo === '<none>' || !repo.startsWith('zhishi-env-')) continue; // 边界：非 zhishi-env-* 不纳管
    const recipeId = repo.slice('zhishi-env-'.length);
    if (!recipeId) continue;
    items.push({ driver: 'docker-image', id: text, name: text, image: text, recipeId });
  }
  return items;
}

/**
 * 1.5.10 镜像发现：列出本机 zhishi-env-* 镜像（只读，不写配置）。复用
 * EnvResult 契约，docker 不可用时 ok:false 由聚合层降级，绝不抛错。
 */
export async function envImages(
  options: LifecycleOptions = {},
): Promise<EnvResult<{ images: DiscoveredDockerImage[] }>> {
  const exec = options.exec ?? defaultDockerExec;
  const result = await exec(['docker', ...buildDockerImagesArgs()], DOCKER_PS_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `docker images 失败（Docker 不可用？）：\n${outputTail(result)}`,
    };
  }
  return { ok: true, images: parseDockerImages(result.stdout) };
}

/**
 * `docker rmi <image>`（按镜像名/ID）。不带 -f——有容器引用时 daemon 侧拒绝，
 * admin 层另有前置安全闸（登记环境占用/容器引用检查）给可读错误。
 */
export function buildDockerRmiArgs(image: string): string[] {
  return ['rmi', image];
}

/**
 * 1.6.3 #8：删除本机镜像（docker rmi 语义，environment/image-remove 的实体
 * 通道）。复用 EnvResult 契约，失败给可读错误，绝不抛错。
 */
export async function envRemoveImage(
  image: string,
  options: LifecycleOptions = {},
): Promise<EnvResult<{ removed: string }>> {
  const exec = options.exec ?? defaultDockerExec;
  const result = await exec(['docker', ...buildDockerRmiArgs(image)], DOCKER_RUN_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `docker rmi 失败（镜像 "${image}"）：\n${outputTail(result)}`,
    };
  }
  return { ok: true, removed: image };
}

// ---------------------------------------------------------------------------
// I/O — default exec (same shape as engines.ts::defaultEngineExec)
// ---------------------------------------------------------------------------

/** docker build can pull base images on first run — generous timeout. */
export const DOCKER_BUILD_TIMEOUT_MS = 45 * 60_000;
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
 * docker build 尾段（envUp 的 (c) 分支与 envRebuild 共用，1.5.10 抽出）：
 * 输出落日志（logDir 配置时）；1.5.9 超时恢复（客户端超时被杀但 daemon
 * 侧构建完成 → inspect 命中按成功续走）保留在本分支；失败先跑 1.5.7/1.5.8
 * 网络形态识别，命中则指引在前、原 stderr 尾部在后。
 */
async function dockerBuildImage(
  recipe: EnvironmentRecipe,
  exec: DockerExec,
  options: LifecycleOptions,
): Promise<EnvResult<object>> {
  const buildArgs = buildDockerBuildArgs(recipe);
  let buildResult = await exec(['docker', ...buildArgs], DOCKER_BUILD_TIMEOUT_MS);
  appendLog(
    options.logDir,
    `${recipe.id}-build.log`,
    `$ docker ${buildArgs.join(' ')}\n${buildResult.stdout}${buildResult.stderr}\n`,
  );
  // 1.5.9 超时恢复：BuildKit 的构建在 daemon 侧——客户端被超时杀掉后构建
  // 仍在 daemon 继续（实机：慢网络 45min 内构建实际完成、镜像出来，但我们
  // 报了失败）。超时错误时检查镜像是否已在 daemon 完成，在则视为构建成功
  // 继续 run（镜像层缓存也让紧随的 rebuild 秒回）。
  if (
    (buildResult.exitCode !== 0 || buildResult.error)
    && (buildResult.error ?? '').startsWith('timed out')
  ) {
    const inspect = await exec(
      ['docker', 'image', 'inspect', imageTagFor(recipe.id)],
      DOCKER_PROBE_TIMEOUT_MS,
    );
    if (inspect.exitCode === 0 && !inspect.error) {
      console.warn(`[env-lifecycle] docker build 客户端超时，但镜像 ${imageTagFor(recipe.id)} 已在 daemon 完成——视为成功继续`);
      appendLog(options.logDir, `${recipe.id}-build.log`, '[zhishi] 客户端超时后镜像已在 daemon 完成，按成功续走\n');
      buildResult = { exitCode: 0, stdout: buildResult.stdout, stderr: buildResult.stderr };
    }
  }
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
  return { ok: true };
}

/**
 * docker run 尾段（envUp/envRebuild/envReset 共用，1.5.10 抽出）：
 * 起常驻容器（命名 zhishi-<recipe>-<shortid>，label + /workspace bind mount
 * + 首跑钩子），输出落日志，返回 EnvInstance。
 */
async function dockerRunContainer(
  recipe: Pick<EnvironmentRecipe, 'id'>,
  workspace: string,
  exec: DockerExec,
  options: LifecycleOptions,
): Promise<EnvResult<{ instance: EnvInstance }>> {
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

/**
 * envUp：1.5.10 链路重排——(a) 同配方容器（含已停止）：在跑幂等返回 /
 * 已停止 docker start 现场续上；(b) 无容器有镜像 → 直接 run（秒开）；
 * (c) 无镜像 → build → run。VM 配方直接报内部路由错误（不碰 docker，
 * VM 由 vm-lifecycle.ts 接管）；docker 不可用报带引导的错误。
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

  // 1.5.10 (a)：同配方容器查找（ps -a 含已停止——现场持久层）。在跑 → 幂等
  // 返回（原 1.3.8 B6 语义，重复 up 不泄漏孤儿容器）；已停止 → docker start
  // 现场续上（1.5.10 核心：/tmp 现场、装过的工具都还在）。ps 失败（docker
  // 抖动）容忍，照走后续分支。fresh=true（镜像行「启动为环境」）跳过本分支
  // ——派生新容器，不激活老容器。
  const psResult = options.fresh
    ? null
    : await exec(['docker', ...buildDockerPsByRecipeArgs(recipe.id)], DOCKER_PS_TIMEOUT_MS);
  if (psResult && psResult.exitCode === 0 && !psResult.error) {
    const existing = parseDockerPs(psResult.stdout).find((i) => i.recipe === recipe.id);
    if (existing) {
      if (existing.status.startsWith('Up')) return { ok: true, instance: existing };
      const startResult = await exec(['docker', 'start', existing.id], DOCKER_RUN_TIMEOUT_MS);
      if (startResult.exitCode === 0 && !startResult.error) {
        return { ok: true, instance: { ...existing, status: 'Up' } };
      }
      // start 失败 = 容器损坏，现场已不可续：清残壳（best-effort，避免下次
      // up 再撞同一个坏容器）后回落 build/run 分支——原容器现场随残壳丢失。
      console.warn(
        `[env-lifecycle] docker start ${existing.name}（${existing.id}）失败——容器损坏，现场不可续，回落重建（原容器现场丢失）：${outputTail(startResult)}`,
      );
      await exec(['docker', 'rm', '-f', existing.id], DOCKER_RUN_TIMEOUT_MS);
    }
  }

  // 1.5.10 (b)：无容器 → 镜像在（inspect 命中）→ 直接 run（跳过 build，秒开）。
  const inspect = await exec(
    ['docker', 'image', 'inspect', imageTagFor(recipe.id)],
    DOCKER_PROBE_TIMEOUT_MS,
  );
  if (inspect.exitCode !== 0 || inspect.error) {
    // 1.5.10 (c)：镜像不在 → build → run。
    const built = await dockerBuildImage(recipe, exec, options);
    if (!built.ok) return built;
  }

  return dockerRunContainer(recipe, workspace, exec, options);
}

/**
 * envDown：只 stop 不 rm（1.5.10 容器现场持久——down 语义由销毁改暂停，
 * /tmp crash 现场、装过的工具保留，下次 up 走 docker start 续上）。
 * 真删除归 environment/rm（envRmContainer）/ environment/reset / rebuild。
 * stop 未成功（已停止/已消失）按「已暂停」幂等放行。
 */
export async function envDown(
  instanceId: string,
  options: LifecycleOptions = {},
): Promise<EnvResult<{ stopped: string }>> {
  const exec = options.exec ?? defaultDockerExec;

  const stopResult = await exec(['docker', 'stop', instanceId], DOCKER_RUN_TIMEOUT_MS);
  if (stopResult.exitCode !== 0 || stopResult.error) {
    console.warn(`[env-lifecycle] docker stop ${instanceId} 未成功（视为已暂停——容器保留现场，不 rm）：${outputTail(stopResult)}`);
  }
  return { ok: true, stopped: instanceId };
}

/**
 * 1.5.10：rm 端点的真删除语义——stop（幂等，已停不报错）+ rm 容器，容器
 * 现场随删。environment/rm 的 docker 分支与 rebuild/reset 清旧容器共用。
 */
export async function envRmContainer(
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
 * 1.5.10 environment/rebuild：显式重建——不看镜像在不在，强制 docker build
 * （配方内容更新/镜像损坏的入口）；build 成功后 stop+rm 同配方旧容器（旧
 * 现场随重建销毁），run 新容器。build 失败时旧容器不动（重建不毁现场）。
 */
export async function envRebuild(
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

  // 强制 build（不看镜像在不在）；失败 → 旧容器原样保留，现场不丢。
  const built = await dockerBuildImage(recipe, exec, options);
  if (!built.ok) return built;

  // build 成功 → 清同配方旧容器（含已停止）再 run 新容器。
  const psResult = await exec(['docker', ...buildDockerPsByRecipeArgs(recipe.id)], DOCKER_PS_TIMEOUT_MS);
  if (psResult.exitCode === 0 && !psResult.error) {
    for (const old of parseDockerPs(psResult.stdout)) {
      if (old.recipe !== recipe.id) continue;
      const removed = await envRmContainer(old.id, { ...options, exec });
      if (!removed.ok) {
        return {
          ok: false,
          error: `旧容器 "${old.name}" 清理失败，重建中止（新镜像已构建，旧容器保留）：\n${removed.error}`,
        };
      }
    }
  }

  return dockerRunContainer(recipe, workspace, exec, options);
}

/**
 * 1.5.10 environment/reset：换干净房间——镜像不动，stop+rm 条目容器后 run
 * 新容器。容器定位：优先 options.container（条目 container 名）；缺省按
 * zhishi.env=<recipeId> label 反查首个同配方容器（同时取回 zhishi.workspace
 * label 作 run 挂载目录——条目不存 workspace，容器 label 存）。无容器可 rm
 * 时直接 run（幂等）。
 */
export async function envReset(
  recipeId: string,
  workspace: string | undefined,
  options: LifecycleOptions & { container?: string } = {},
): Promise<EnvResult<{ instance: EnvInstance }>> {
  const exec = options.exec ?? defaultDockerExec;

  const dockerError = await ensureDockerAvailable(exec);
  if (dockerError) return { ok: false, error: dockerError };

  let target = options.container;
  let ws = workspace;
  const psResult = await exec(['docker', ...buildDockerPsByRecipeArgs(recipeId)], DOCKER_PS_TIMEOUT_MS);
  if (psResult.exitCode === 0 && !psResult.error) {
    const rows = parseDockerPs(psResult.stdout);
    const want = target;
    const hit = want
      ? rows.find((i) => i.name === want || i.id === want || i.id.startsWith(want))
      : rows[0];
    if (hit) {
      target = hit.name;
      ws = ws ?? hit.workspace;
    }
  }
  if (target) {
    const removed = await envRmContainer(target, { exec });
    if (!removed.ok) return { ok: false, error: removed.error };
  }

  // run 只需配方 id（镜像不动——reset 不 build，不需要配方目录）。
  return dockerRunContainer({ id: recipeId }, ws ?? process.cwd(), exec, options);
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
