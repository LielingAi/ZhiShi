/**
 * 安全研究员版 P2 — VM 环境配方生命周期（VMware Workstation vmrun 驱动）.
 *
 * D22 直连真实 VM：config.json::vmTemplates[recipeId] 条目（adopt/build 的
 * 产出）**就是环境本身**，不再整目录拷贝派生实例（实测撞墙：真实 VM 上百 G，
 * 没有分区放得下拷贝；模板/派生双份冗余多此一举）。干净现场靠快照 revert，
 * 不靠复制。生命周期命令：
 *
 *   vmEnvUp(recipe, workspace, { vmBase })
 *     1. 探测 vmware（复用 E1 engines 的 vmrun probe spec + guidance）
 *     2. 解析 vmx（--vm-base flag > 配方 frontmatter vm_base > vmTemplates）
 *     3. vmrun list 已含该 vmx → 幂等：只刷新 IP 返回 ok
 *     4. 快照约定：recipe.vmSnapshot 存在 → revertToSnapshot（每次 up 干净现场）
 *     5. vmrun -T ws start <vmx> nogui（失败后重试一次，见下）
 *     6. vmrun getGuestIPAddress <vmx> -wait → guest 地址（需 VMware Tools）
 *   vmEnvDown(.vmx)     → vmrun stop soft（VM 文件是用户的，绝不删）
 *   vmEnvPs()           → vmrun list 的全部运行中 vmx（与登记条目求交在
 *                         admin-api 层做——本模块不读 config）
 *
 * env 条目 id = recipe.id（一台 VM 一个环境条目）；rm = 只摘登记
 * （removeEnvironmentEntry），实现在 admin-api——真实 VM 不是一次性拷贝。
 *
 * 访客通道：up 拿到 address 后由 admin-api 回写 env 条目（kind: vm），
 * `env open` 走既有 SSH 路径（registry.resolveEnvOpenCommand）；无网络的
 * 隔离 VM 走 guest-exec 通道（vm-guest-exec.ts，P2 B2，`zhishi env exec`）。
 *
 * 结构照 `docker-lifecycle.ts`：vmrun 命令组装与输出解析是纯函数；所有进程
 * 调用走可注入的 `VmExec`，单测绝不真调 vmrun。
 */

import { existsSync } from 'node:fs';

import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { spawn as spawnSubprocess } from '../utils/subprocess';
import { ENGINE_SPECS, parseEngineProbeResult } from './engines';
import type { EnvironmentRecipe } from './recipes';
import { resolveVmrunBinary } from './vmrun-path';

export type EnvResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** 一个直连的 VM 环境（D22：id = recipe.id，vmx 路径即定位锚）。 */
export interface VmInstance {
  /** = recipe.id（一台 VM 一个环境条目）。 */
  id: string;
  name: string;
  /** 环境 .vmx 绝对路径（down/rm/ps 的定位锚）。 */
  vmx: string;
  /** guest 地址（up 时 getGuestIPAddress 取得；取不到则缺省）。 */
  address?: string;
  status: string;
  recipe: string;
  workspace: string;
}

export interface VmExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Spawn-level error message (ENOENT etc.) when the process never ran. */
  error?: string;
}

export type VmExec = (argv: string[], timeoutMs: number) => Promise<VmExecResult>;

export interface VmLifecycleOptions {
  exec?: VmExec;
  /** VM 的 .vmx 绝对路径（覆盖 recipe.vmBase / vmTemplates 解析结果）。 */
  vmBase?: string;
}

// ---------------------------------------------------------------------------
// Pure functions — vmrun command assembly + output parsing
// ---------------------------------------------------------------------------

/** hyperv/vbox 驱动仍用派生实例名（zhishi-<recipe>-<shortid>），保留此 helper。 */
export function vmInstanceNameFor(recipeId: string, shortId: string): string {
  return `zhishi-${recipeId}-${shortId}`;
}

/** 全部命令带 `-T ws`（Workstation 宿主类型），否则 vmrun 可能误判宿主。 */
export function buildVmrunStartArgs(vmx: string): string[] {
  return ['-T', 'ws', 'start', vmx, 'nogui'];
}

/** soft = guest 内正常关机（需 VMware Tools）；失败由调用方提示可手动 hard。 */
export function buildVmrunStopArgs(vmx: string): string[] {
  return ['-T', 'ws', 'stop', vmx, 'soft'];
}

export function buildVmrunListArgs(): string[] {
  return ['-T', 'ws', 'list'];
}

export function buildVmrunListSnapshotsArgs(vmx: string): string[] {
  return ['-T', 'ws', 'listSnapshots', vmx];
}

export function buildVmrunSnapshotArgs(vmx: string, name: string): string[] {
  return ['-T', 'ws', 'snapshot', vmx, name];
}

export function buildVmrunRevertArgs(vmx: string, name: string): string[] {
  return ['-T', 'ws', 'revertToSnapshot', vmx, name];
}

/** `-wait` 阻塞到 VMware Tools 上报 IP；超时由 exec 层兜底。 */
export function buildVmrunGetIpArgs(vmx: string): string[] {
  return ['-T', 'ws', 'getGuestIPAddress', vmx, '-wait'];
}

/**
 * Parse `vmrun list` output into running .vmx paths. Format:
 *   Total running VMs: 2
 *   C:\path\one.vmx
 *   C:\path\two.vmx
 * 首行计数头跳过；坏行（非 .vmx 结尾）跳过，不炸整列。
 */
export function parseVmrunList(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    if (/^Total running VMs:/i.test(trimmed)) continue;
    if (!/\.vmx$/i.test(trimmed)) continue;
    paths.push(trimmed);
  }
  return paths;
}

/**
 * Parse `vmrun listSnapshots` output into snapshot names. Format:
 *   Total snapshots: 2
 *   clean
 *   after-tools
 * 旧版输出可能带计数头；名字逐行保留（快照名可含空格，故不 split）。
 */
export function parseVmrunSnapshotList(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    if (/^Total snapshots:/i.test(trimmed)) continue;
    names.push(trimmed);
  }
  return names;
}

/** getGuestIPAddress 输出就是 IP 本体；取首个 IPv4 字面量，容错多余行。 */
export function parseGuestIp(stdout: string): string | undefined {
  const match = stdout.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return match ? match[0] : undefined;
}

/** vmrun list 输出的路径写法（盘符大小写 / 斜杠方向）不保证与输入一致，统一规整再比较。 */
export function normalizeVmxPath(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase();
}

// ---------------------------------------------------------------------------
// I/O — default exec (same shape as docker-lifecycle.ts::defaultDockerExec)
// ---------------------------------------------------------------------------

export const VMRUN_PROBE_TIMEOUT_MS = 10_000;
export const VMRUN_START_TIMEOUT_MS = 120_000;
export const VMRUN_STOP_TIMEOUT_MS = 120_000;
export const VMRUN_LIST_TIMEOUT_MS = 15_000;
/** getGuestIPAddress -wait 要等 guest 开机 + Tools 上报 + DHCP，给足。 */
export const VMRUN_GET_IP_TIMEOUT_MS = 5 * 60_000;

// vm-guest-exec（P2 B2）也复用同一默认 exec（纯增量 export，行为不变）。
export async function defaultVmrunExec(argv: string[], timeoutMs: number): Promise<VmExecResult> {
  // vmrun 特例：自定义安装路径（D:\vm 等）不进 PATH，注册表兜底解析
  const binary = argv[0] === 'vmrun' ? resolveVmrunBinary() : resolveCommand(argv[0]);
  const proc = spawnSubprocess([binary, ...argv.slice(1)], {
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

/** Tail of vmrun output for error messages (bounded, last non-empty lines).
 * hyperv/vbox 驱动（P2 B3）复用同一格式，故导出。 */
export function outputTailOf(result: VmExecResult, maxLines = 5): string {
  const text = (result.stderr || result.stdout || '').trim();
  if (!text) return result.error ?? '';
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(-maxLines).join('\n');
}

/**
 * vmware 可用性前置检查：复用 E1 的 vmware probe spec（`vmrun list`）+
 * guidance，exec 注入化。返回 null = 可用，否则为用户可读的引导错误。
 */
export async function ensureVmwareAvailable(exec: VmExec): Promise<string | null> {
  const spec = ENGINE_SPECS.find((s) => s.kind === 'vmware');
  if (!spec) return null;
  let probe: VmExecResult;
  try {
    probe = await exec(spec.argv, VMRUN_PROBE_TIMEOUT_MS);
  } catch (err) {
    probe = { exitCode: -1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
  const status = parseEngineProbeResult(spec, probe);
  if (status.available) return null;
  return [status.guidance, status.detail].filter(Boolean).join(' — ');
}

/**
 * vmEnvUp（D22 直连）：对解析出的 vmx 直接操作——已在跑则幂等（只刷新
 * IP）；否则（快照约定存在则 revert）→ start nogui → 取 guest IP。
 * vmBase 缺失 / vmware 不可用 / 任一步失败都报用户可读错误；start 成功后
 * 取 IP 失败不算 up 失败（VM 已在跑，address 缺省，open 时报未配置）。
 */
export async function vmEnvUp(
  recipe: EnvironmentRecipe,
  workspace: string,
  options: VmLifecycleOptions = {},
): Promise<EnvResult<{ instance: VmInstance }>> {
  if (recipe.base !== 'vm') {
    return { ok: false, error: `配方 "${recipe.id}" 不是 VM 配方（base: ${recipe.base ?? '?'}）` };
  }

  const vmBase = options.vmBase ?? recipe.vmBase;
  if (!vmBase) {
    return {
      ok: false,
      error:
        `VM 配方 "${recipe.id}" 缺少 .vmx 定位。三条路任选：\n` +
        `① 已有装好系统的 VM → zhishi env adopt ${recipe.id} --vm <它的.vmx>（养成后登记，之后免 --vm-base）；\n` +
        `② 临时指定 → zhishi env up ${recipe.id} --vm-base <VM.vmx>；\n` +
        '③ 配方 frontmatter 写 vm_base。',
    };
  }
  if (!/\.vmx$/i.test(vmBase)) {
    return { ok: false, error: `--vm-base 必须指向 VM 的 .vmx 文件（收到："${vmBase}"）` };
  }
  if (!existsSync(vmBase)) {
    return { ok: false, error: `VM 不存在："${vmBase}"（--vm-base / vmTemplates 指向一个已导入 Workstation 的 .vmx）` };
  }
  const vmx = vmBase;

  const exec = options.exec ?? defaultVmrunExec;

  const vmwareError = await ensureVmwareAvailable(exec);
  if (vmwareError) return { ok: false, error: vmwareError };

  // ① 幂等：已在运行列表里 → 不 revert 不 start（revert 会丢 guest 内现场），
  // 只刷新 IP 后返回。
  const listResult = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
  const alreadyRunning =
    listResult.exitCode === 0 &&
    !listResult.error &&
    parseVmrunList(listResult.stdout).some((p) => normalizeVmxPath(p) === normalizeVmxPath(vmx));

  if (!alreadyRunning) {
    // ② 快照约定：声明的快照存在 → 先 revert，保证每次 up 都是干净现场；
    // 不存在（首次 up / VM 未做快照）则跳过，不阻断。
    if (recipe.vmSnapshot) {
      const snapshotsResult = await exec(['vmrun', ...buildVmrunListSnapshotsArgs(vmx)], VMRUN_LIST_TIMEOUT_MS);
      if (snapshotsResult.exitCode === 0 && parseVmrunSnapshotList(snapshotsResult.stdout).includes(recipe.vmSnapshot)) {
        const revertResult = await exec(['vmrun', ...buildVmrunRevertArgs(vmx, recipe.vmSnapshot)], VMRUN_START_TIMEOUT_MS);
        if (revertResult.exitCode !== 0 || revertResult.error) {
          return {
            ok: false,
            error: `revertToSnapshot "${recipe.vmSnapshot}" 失败（${vmx}）：\n${outputTailOf(revertResult)}`,
          };
        }
      }
    }

    // ③ start nogui
    const startResult = await exec(['vmrun', ...buildVmrunStartArgs(vmx)], VMRUN_START_TIMEOUT_MS);
    if (startResult.exitCode !== 0 || startResult.error) {
      // 实测（2026-08-15）：vmrun start 偶发「未知错误」（挂起态残留/锁文件），
      // 同一命令立即重试即成功——失败时重试一次再报错。
      const retry = await exec(['vmrun', ...buildVmrunStartArgs(vmx)], VMRUN_START_TIMEOUT_MS);
      if (retry.exitCode !== 0 || retry.error) {
        return {
          ok: false,
          error: `vmrun start 失败（${vmx}）：\n${outputTailOf(retry)}`,
        };
      }
    }
  }

  // ④ guest IP（容错：取不到只 warn，VM 已在跑）
  let address: string | undefined;
  const ipResult = await exec(['vmrun', ...buildVmrunGetIpArgs(vmx)], VMRUN_GET_IP_TIMEOUT_MS);
  if (ipResult.exitCode === 0 && !ipResult.error) {
    address = parseGuestIp(ipResult.stdout);
  }
  if (!address) {
    console.warn(
      `[vm-lifecycle] VM "${recipe.id}"（${vmx}）已启动，但未拿到 guest IP（VMware Tools 未装/无网络？）。` +
      'env open 需要 address——guest 配好网络后重 up 刷新，或走 zhishi env exec 的 guest-exec 通道。',
    );
  }

  return {
    ok: true,
    instance: {
      id: recipe.id,
      name: recipe.id,
      vmx,
      address,
      status: 'running',
      recipe: recipe.id,
      workspace,
    },
  };
}

/** vmEnvDown：stop soft。只收 .vmx 路径——env id → vmx 的解析在 admin-api
 * 层做（本模块不读 config）。VM 文件是用户的真实系统，绝不在此删除。 */
export async function vmEnvDown(
  idOrVmx: string,
  options: VmLifecycleOptions = {},
): Promise<EnvResult<{ stopped: string }>> {
  const exec = options.exec ?? defaultVmrunExec;

  if (!/\.vmx$/i.test(idOrVmx)) {
    return {
      ok: false,
      error: `未知 VM "${idOrVmx}"——请传 env id 或 .vmx 路径（zhishi env ps 查看运行中环境）`,
    };
  }
  const vmx = idOrVmx;

  const stopResult = await exec(['vmrun', ...buildVmrunStopArgs(vmx)], VMRUN_STOP_TIMEOUT_MS);
  if (stopResult.exitCode !== 0 || stopResult.error) {
    return {
      ok: false,
      error:
        `vmrun stop 失败（${vmx}）：\n${outputTailOf(stopResult)}\n` +
        'guest 无响应时可手动 vmrun -T ws stop <vmx> hard（等同断电，有丢数据风险）',
    };
  }
  return { ok: true, stopped: idOrVmx };
}

/** vmEnvPs：vmrun list 的全部运行中 vmx 路径（D22 直连后不再按实例目录
 * 过滤）——与登记条目求交、产出环境实例列表是 admin-api 层的职责。 */
export async function vmEnvPs(
  options: VmLifecycleOptions = {},
): Promise<EnvResult<{ vmxes: string[] }>> {
  const exec = options.exec ?? defaultVmrunExec;

  const result = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `vmrun list 失败（VMware 不可用？）：\n${outputTailOf(result)}`,
    };
  }
  return { ok: true, vmxes: parseVmrunList(result.stdout) };
}
