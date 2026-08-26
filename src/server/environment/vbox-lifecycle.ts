/**
 * 安全研究员版 P2 B3 — VM 环境配方生命周期（VirtualBox VBoxManage 驱动）.
 *
 * 模板模型：模板 = **已注册的 VirtualBox VM 名**（frontmatter `vm_base` 或
 * `--vm-base` 给 VM 名——VBox 的 VM 文件由 VBox 自己管在 default machine
 * folder，不做目录拷贝）。生命周期命令（VBoxManage，exec 注入化）：
 *
 *   vboxEnvUp(recipe, workspace, { vmBase })
 *     1. 探测 virtualbox（复用 E1 engines 的 virtualbox probe spec + guidance）
 *     2. VBoxManage clonevm <模板> --name zhishi-<recipe>-<shortid> --register
 *     3. 快照约定：recipe.vmSnapshot 存在 → snapshot <name> restore（干净现场）
 *     4. VBoxManage startvm <name> --type headless
 *     5. 轮询 guestproperty get "/VirtualBox/GuestInfo/Net/0/V4/IP"
 *        （'No value set!' 视为未就绪；取不到不算 up 失败，与 vmware 语义一致）
 *   vboxEnvDown(name) → controlvm <name> acpipowerbutton（soft；失败引导 poweroff）
 *   vboxEnvPs()       → list runningvms，过滤 zhishi- 前缀
 *   vboxEnvPsAll()    → list vms 全量（discover 用，1.3.8 B5）
 *   vboxEnvRm(name)   → unregistervm <name> --delete（须已停）
 *
 * 结构照 `vm-lifecycle.ts`：VBoxManage 参数组装与输出解析是纯函数；所有
 * 进程调用走可注入的 `VmExec`（复用 vm-lifecycle 的类型；默认 exec 与
 * defaultVmrunExec 同构，仅二进制解析换 resolveVBoxManageBinary——
 * 自定义安装路径不进 PATH，注册表 InstallDir 兜底）。单测绝不真调
 * VBoxManage。无本地实例目录（VM 文件归 VBox 管），rm 不碰 fs。
 */

import { randomBytes } from 'node:crypto';

import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { spawn as spawnSubprocess } from '../utils/subprocess';
import { ENGINE_SPECS, parseEngineProbeResult } from './engines';
import type { EnvironmentRecipe } from './recipes';
import { resolveVBoxManageBinary } from './vboxmanage-path';
import {
  outputTailOf,
  vmInstanceNameFor,
  type EnvResult,
  type VmExec,
  type VmExecResult,
} from './vm-lifecycle';

/** 一个由 VirtualBox 驱动启动的实例（VBox VM 名即身份，无本地目录）。 */
export interface VboxInstance {
  /** 实例名 zhishi-<recipe>-<shortid>（= VirtualBox VM 名）。 */
  id: string;
  name: string;
  /** 模板 VM 名（up 时的 vmBase；ps 时未知）。 */
  template?: string;
  /** guest 地址（up 时轮询 guestproperty 取得；ps 时未知）。 */
  address?: string;
  status: string;
  recipe: string;
  workspace: string;
}

export interface VboxPollControl {
  /** IP 轮询总预算（默认 VBOX_GET_IP_TIMEOUT_MS）。 */
  deadlineMs?: number;
  /** 轮询间隔（默认 VBOX_IP_POLL_INTERVAL_MS）。 */
  intervalMs?: number;
  /** 时钟与睡眠注入点——单测绝不真等。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface VboxLifecycleOptions {
  exec?: VmExec;
  /** 实例名后缀；可注入以便测试。默认 8 位随机 hex。 */
  shortId?: () => string;
  /** 模板 VM 名（覆盖 recipe.vmBase）。 */
  vmBase?: string;
  /** IP 轮询控制（deadline/间隔/时钟全注入化）。 */
  ipPoll?: VboxPollControl;
}

// ---------------------------------------------------------------------------
// Pure functions — VBoxManage argument assembly + output parsing
// ---------------------------------------------------------------------------

/** clonevm：从已注册模板完整克隆并立即注册（默认 full clone + 新 MAC）。 */
export function buildCloneVmArgs(template: string, name: string): string[] {
  return ['clonevm', template, '--name', name, '--register'];
}

/** `snapshot <vm> list`：列出全部快照名（树形缩进输出，解析器逐行提 Name:）。 */
export function buildSnapshotListArgs(name: string): string[] {
  return ['snapshot', name, 'list'];
}

export function buildSnapshotRestoreArgs(name: string, snapshot: string): string[] {
  return ['snapshot', name, 'restore', snapshot];
}

export function buildStartVmArgs(name: string): string[] {
  return ['startvm', name, '--type', 'headless'];
}

/** acpipowerbutton = guest 内正常关机（需 Guest Additions 的 ACPI 处理）。 */
export function buildAcpiPowerdownArgs(name: string): string[] {
  return ['controlvm', name, 'acpipowerbutton'];
}

export function buildListRunningArgs(): string[] {
  return ['list', 'runningvms'];
}

/** discover 全量枚举（1.3.8 B5）：list vms = 全部已注册 VM（含已停止）。 */
export function buildListVmsArgs(): string[] {
  return ['list', 'vms'];
}

/** guest IP 来源：Guest Additions 上报的 guest property（首张网卡 IPv4）。 */
export function buildGuestIpArgs(name: string): string[] {
  return ['guestproperty', 'get', name, '/VirtualBox/GuestInfo/Net/0/V4/IP'];
}

export function buildUnregisterArgs(name: string): string[] {
  return ['unregistervm', name, '--delete'];
}

/** 名字存在性探测：注册表里有这台 VM 则 exit 0。 */
export function buildShowVmInfoArgs(name: string): string[] {
  return ['showvminfo', name, '--machinereadable'];
}

/**
 * 解析 `VBoxManage list runningvms` 输出为 VM 名列表。格式：
 *   "zhishi-pwn-vm-a1b2c3d4" {a1b2c3d4-...}
 *   "Windows 10" {9b8...}
 * 名字可含空格，故用引号锚定；坏行跳过，不炸整列。
 */
export function parseVBoxRunningVms(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.replace(/\r$/, '').match(/^"([^"]+)"\s+\{[^}]*\}\s*$/);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * 解析 `VBoxManage snapshot <vm> list` 输出为快照名列表。格式（树形缩进）：
 *    Name: zhishi-clean (UUID: ...)
 *      Name: child snap (UUID: ...)
 */
export function parseVBoxSnapshotNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.replace(/\r$/, '').match(/^\s*Name:\s*(.+?)\s*\(UUID:/);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * 解析 `guestproperty get` 输出。就绪：`Value: 10.0.2.15`；未就绪：
 * `No value set!`。两种之外的输出（空串/报错文本）都视为未就绪。
 */
export function parseVBoxGuestPropertyIp(stdout: string): string | undefined {
  const match = stdout.match(/Value:\s*(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// I/O — default exec (same shape as vm-lifecycle.ts::defaultVmrunExec)
// ---------------------------------------------------------------------------

export const VBOX_PROBE_TIMEOUT_MS = 10_000;
export const VBOX_CLONE_TIMEOUT_MS = 10 * 60_000;
export const VBOX_START_TIMEOUT_MS = 120_000;
export const VBOX_STOP_TIMEOUT_MS = 120_000;
export const VBOX_LIST_TIMEOUT_MS = 15_000;
/** guestproperty 要等 guest 开机 + Guest Additions 上报 + DHCP，给足。 */
export const VBOX_GET_IP_TIMEOUT_MS = 3 * 60_000;
export const VBOX_IP_POLL_INTERVAL_MS = 3_000;

export async function defaultVBoxExec(argv: string[], timeoutMs: number): Promise<VmExecResult> {
  // VBoxManage 特例：默认安装路径不一定进 PATH（GUI 精简 PATH），注册表兜底解析
  const binary = argv[0] === 'VBoxManage' ? resolveVBoxManageBinary() : resolveCommand(argv[0]);
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

/**
 * virtualbox 可用性前置检查：复用 E1 的 virtualbox probe spec
 * （VBoxManage --version）+ guidance，exec 注入化。返回 null = 可用，
 * 否则为用户可读的引导错误。
 */
export async function ensureVirtualBoxAvailable(exec: VmExec): Promise<string | null> {
  const spec = ENGINE_SPECS.find((s) => s.kind === 'virtualbox');
  if (!spec) return null;
  let probe: VmExecResult;
  try {
    probe = await exec(spec.argv, VBOX_PROBE_TIMEOUT_MS);
  } catch (err) {
    probe = { exitCode: -1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
  const status = parseEngineProbeResult(spec, probe);
  if (status.available) return null;
  return [status.guidance, status.detail].filter(Boolean).join(' — ');
}

/** IP 轮询：deadline 内反复查 guest property，拿到 IPv4 即返回。 */
async function pollGuestIp(
  name: string,
  exec: VmExec,
  control: VboxPollControl = {},
): Promise<string | undefined> {
  const now = control.now ?? (() => Date.now());
  const sleep = control.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (control.deadlineMs ?? VBOX_GET_IP_TIMEOUT_MS);
  const interval = control.intervalMs ?? VBOX_IP_POLL_INTERVAL_MS;
  for (;;) {
    const result = await exec(['VBoxManage', ...buildGuestIpArgs(name)], VBOX_LIST_TIMEOUT_MS);
    if (result.exitCode === 0 && !result.error) {
      const ip = parseVBoxGuestPropertyIp(result.stdout);
      if (ip) return ip;
    }
    if (now() >= deadline) return undefined;
    await sleep(interval);
  }
}

/**
 * vboxEnvUp：clonevm（模板 VM 名 → 新实例）→（快照约定存在则 restore）→
 * startvm headless → 轮询 guest property 取 IP。vmBase 缺失 / VirtualBox
 * 不可用 / 任一步失败都报用户可读错误；start 成功后取不到 IP 不算 up
 * 失败（与 vmware 语义一致，address 缺省，open 时报未配置）。
 */
export async function vboxEnvUp(
  recipe: EnvironmentRecipe,
  workspace: string,
  options: VboxLifecycleOptions = {},
): Promise<EnvResult<{ instance: VboxInstance }>> {
  if (recipe.base !== 'vm') {
    return { ok: false, error: `配方 "${recipe.id}" 不是 VM 配方（base: ${recipe.base ?? '?'}）` };
  }

  const vmBase = options.vmBase ?? recipe.vmBase;
  if (!vmBase) {
    return {
      ok: false,
      error:
        `VirtualBox 配方 "${recipe.id}" 缺少模板。VirtualBox 模板 = 已注册的 VM 名` +
        '（VBoxManage list vms 查看）。两条路任选：\n' +
        `① 临时指定 → zhishi env up ${recipe.id} --vm-base <模板 VM 名>；\n` +
        '② 配方 frontmatter 写 vm_base。\n' +
        '（env adopt / env build 自动养成模板暂只支持 vmware）',
    };
  }

  const exec = options.exec ?? defaultVBoxExec;

  const vboxError = await ensureVirtualBoxAvailable(exec);
  if (vboxError) return { ok: false, error: vboxError };

  const shortId = (options.shortId ?? (() => randomBytes(4).toString('hex')))();
  const instanceName = vmInstanceNameFor(recipe.id, shortId);

  const cloneResult = await exec(['VBoxManage', ...buildCloneVmArgs(vmBase, instanceName)], VBOX_CLONE_TIMEOUT_MS);
  if (cloneResult.exitCode !== 0 || cloneResult.error) {
    return {
      ok: false,
      error:
        `clonevm 失败（模板 "${vmBase}" → 实例 "${instanceName}"；模板须是已注册 VM 名，` +
        `VBoxManage list vms 可查）：\n${outputTailOf(cloneResult)}`,
    };
  }

  // 快照约定：声明的快照存在 → 先 restore，保证每次 up 都是干净现场；
  // 不存在（首次 up / 模板未做快照）则跳过，不阻断。
  if (recipe.vmSnapshot) {
    const listResult = await exec(['VBoxManage', ...buildSnapshotListArgs(instanceName)], VBOX_LIST_TIMEOUT_MS);
    if (listResult.exitCode === 0 && parseVBoxSnapshotNames(listResult.stdout).includes(recipe.vmSnapshot)) {
      const restoreResult = await exec(
        ['VBoxManage', ...buildSnapshotRestoreArgs(instanceName, recipe.vmSnapshot)],
        VBOX_START_TIMEOUT_MS,
      );
      if (restoreResult.exitCode !== 0 || restoreResult.error) {
        return {
          ok: false,
          error: `snapshot restore "${recipe.vmSnapshot}" 失败（实例 "${instanceName}"）：\n${outputTailOf(restoreResult)}`,
        };
      }
    }
  }

  const startResult = await exec(['VBoxManage', ...buildStartVmArgs(instanceName)], VBOX_START_TIMEOUT_MS);
  if (startResult.exitCode !== 0 || startResult.error) {
    return {
      ok: false,
      error: `startvm 失败（实例 "${instanceName}"）：\n${outputTailOf(startResult)}`,
    };
  }

  const address = await pollGuestIp(instanceName, exec, options.ipPoll);
  if (!address) {
    console.warn(
      `[vbox-lifecycle] 实例 "${instanceName}" 已启动，但未拿到 guest IP（Guest Additions 未装/无网络？）。` +
        'env open 需要 address——guest 配好网络后手动补登 env 条目。',
    );
  }

  return {
    ok: true,
    instance: {
      id: instanceName,
      name: instanceName,
      template: vmBase,
      address,
      status: 'running',
      recipe: recipe.id,
      workspace,
    },
  };
}

/** vboxEnvDown：controlvm acpipowerbutton（soft）。VM 保留（状态可续）。 */
export async function vboxEnvDown(
  name: string,
  options: VboxLifecycleOptions = {},
): Promise<EnvResult<{ stopped: string }>> {
  const exec = options.exec ?? defaultVBoxExec;

  const listResult = await exec(['VBoxManage', ...buildListRunningArgs()], VBOX_LIST_TIMEOUT_MS);
  if (listResult.exitCode !== 0 || listResult.error) {
    return {
      ok: false,
      error: `VBoxManage list runningvms 失败（VirtualBox 不可用？）：\n${outputTailOf(listResult)}`,
    };
  }
  if (!parseVBoxRunningVms(listResult.stdout).includes(name)) {
    return {
      ok: false,
      error: `未找到运行中的 VirtualBox 实例 "${name}"（zhishi env ps 查看运行中实例）`,
    };
  }

  const stopResult = await exec(['VBoxManage', ...buildAcpiPowerdownArgs(name)], VBOX_STOP_TIMEOUT_MS);
  if (stopResult.exitCode !== 0 || stopResult.error) {
    return {
      ok: false,
      error:
        `controlvm acpipowerbutton 失败（${name}）：\n${outputTailOf(stopResult)}\n` +
        `guest 无响应时可手动 VBoxManage controlvm "${name}" poweroff（等同断电，有丢数据风险）`,
    };
  }
  return { ok: true, stopped: name };
}

/**
 * vboxEnvRm：unregistervm --delete（注销并删 VM 文件——VBox 管自己的
 * machine folder，无本地实例目录可清）。安全闸：运行中拒绝（先 down）。
 */
export async function vboxEnvRm(
  name: string,
  options: VboxLifecycleOptions = {},
): Promise<EnvResult<{ removed: string }>> {
  const exec = options.exec ?? defaultVBoxExec;

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { ok: false, error: `非法实例名 "${name}"（仅字母数字/._-）` };
  }

  const infoResult = await exec(['VBoxManage', ...buildShowVmInfoArgs(name)], VBOX_LIST_TIMEOUT_MS);
  if (infoResult.exitCode !== 0 || infoResult.error) {
    return { ok: false, error: `未找到 VirtualBox 实例 "${name}"（zhishi env ps 看运行中实例）` };
  }

  const listResult = await exec(['VBoxManage', ...buildListRunningArgs()], VBOX_LIST_TIMEOUT_MS);
  if (listResult.exitCode === 0 && parseVBoxRunningVms(listResult.stdout).includes(name)) {
    return { ok: false, error: `实例 "${name}" 还在运行——先 zhishi env down ${name}，确认不要了再 rm` };
  }

  const removeResult = await exec(['VBoxManage', ...buildUnregisterArgs(name)], VBOX_STOP_TIMEOUT_MS);
  if (removeResult.exitCode !== 0 || removeResult.error) {
    return {
      ok: false,
      error: `unregistervm --delete 失败（${name}）：\n${outputTailOf(removeResult)}`,
    };
  }
  return { ok: true, removed: name };
}

/** vboxEnvPs：list runningvms 中的 zhishi- 前缀实例。 */
export async function vboxEnvPs(
  options: VboxLifecycleOptions = {},
): Promise<EnvResult<{ instances: VboxInstance[] }>> {
  const exec = options.exec ?? defaultVBoxExec;

  const result = await exec(['VBoxManage', ...buildListRunningArgs()], VBOX_LIST_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `VBoxManage list runningvms 失败（VirtualBox 不可用？）：\n${outputTailOf(result)}`,
    };
  }
  const instances = parseVBoxRunningVms(result.stdout)
    .filter((name) => name.startsWith('zhishi-'))
    .map((name) => ({
      id: name,
      name,
      status: 'running',
      recipe: name.split('-').slice(1, -1).join('-'),
      workspace: '',
    }));
  return { ok: true, instances };
}

/**
 * discover 用的 VirtualBox 全量枚举（1.3.8 B5）：list vms = 全部已注册 VM
 * （不筛 zhishi-* 前缀、含已停止）。list vms 输出不带状态——status 记
 * 'unknown'（running 态判定只有 list runningvms 给得出，ps 语义归
 * vboxEnvPs）。与已登记条目的去重由 GUI 的 matchRegisteredEnv（1.3.7）兜住。
 */
export async function vboxEnvPsAll(
  options: VboxLifecycleOptions = {},
): Promise<EnvResult<{ instances: VboxInstance[] }>> {
  const exec = options.exec ?? defaultVBoxExec;

  const result = await exec(['VBoxManage', ...buildListVmsArgs()], VBOX_LIST_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `VBoxManage list vms 失败（VirtualBox 不可用？）：\n${outputTailOf(result)}`,
    };
  }
  const instances = parseVBoxRunningVms(result.stdout).map((name) => ({
    id: name,
    name,
    status: 'unknown',
    recipe: name.startsWith('zhishi-') ? name.split('-').slice(1, -1).join('-') : '',
    workspace: '',
  }));
  return { ok: true, instances };
}

/**
 * down/rm 路由用的名字存在性探测：容错——VirtualBox 没装 / showvminfo
 * 失败 / 名字不存在都返回 false（绝不炸路由），交给 docker 兜底。
 */
export async function vboxVmExists(name: string, options: VboxLifecycleOptions = {}): Promise<boolean> {
  const exec = options.exec ?? defaultVBoxExec;
  try {
    const result = await exec(['VBoxManage', ...buildShowVmInfoArgs(name)], VBOX_LIST_TIMEOUT_MS);
    return result.exitCode === 0 && !result.error;
  } catch {
    return false;
  }
}
