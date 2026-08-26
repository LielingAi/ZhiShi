/**
 * 安全研究员版 P2 B3 — VM 环境配方生命周期（Hyper-V PowerShell 驱动）.
 *
 * 与 vmware 驱动的模板模型差异：Hyper-V VM 不是目录自包含的，模板 =
 * **Export-VM 导出的目录**（frontmatter `vm_base` 或 `--vm-base` 指向它）。
 * 生命周期命令（全部经 `powershell -NoProfile -Command` 执行）：
 *
 *   hypervEnvUp(recipe, workspace, { vmBase })
 *     1. 探测 hyperv（复用 E1 engines 的 hyperv probe spec + guidance）
 *     2. 在导出目录下定位 .vmcx → Import-VM -Copy -GenerateNewId 拷贝成
 *        新实例（落点 ~/.zhishi/vm-instances-hyperv/<name>/），Rename-VM 成
 *        zhishi-<recipe>-<shortid>
 *     3. 快照约定：recipe.vmSnapshot 存在 → Restore-VMSnapshot（干净现场）
 *     4. Start-VM
 *     5. 轮询 Get-VMNetworkAdapter 的 IPAddresses（取不到不算 up 失败，
 *        与 vmware 语义一致）
 *   hypervEnvDown(name) → Stop-VM（soft；失败引导 -TurnOff，等同断电）
 *   hypervEnvPs()       → Get-VM -Name 'zhishi-*'（Running 过滤）| ConvertTo-Json
 *   hypervEnvPsAll()    → Get-VM 全量（discover 用，1.3.8 B5）
 *   hypervEnvRm(name)   → Remove-VM（须已停）+ 删实例拷贝目录
 *
 * 结构照 `vm-lifecycle.ts`：PowerShell 脚本组装与输出解析是纯函数；所有
 * 进程调用走可注入的 `VmExec`（复用 vm-lifecycle 的类型与默认 exec——
 * argv[0]='powershell' 走 resolveCommand，无需注册表兜底），单测绝不真调
 * powershell。实例拷贝目录是真 fs，测试用临时目录。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { ENGINE_SPECS, parseEngineProbeResult } from './engines';
import type { EnvironmentRecipe } from './recipes';
import {
  defaultVmrunExec,
  outputTailOf,
  parseGuestIp,
  vmInstanceNameFor,
  type EnvResult,
  type VmExec,
  type VmExecResult,
} from './vm-lifecycle';

/** 一个由 Hyper-V 驱动启动的实例（Hyper-V VM 名即身份；dir 是拷贝落点）。 */
export interface HypervInstance {
  /** 实例名 zhishi-<recipe>-<shortid>（= Hyper-V VM 名 = 实例目录名）。 */
  id: string;
  name: string;
  /** Import-VM -Copy 的落点目录（~/.zhishi/vm-instances-hyperv/<name>/）。 */
  dir: string;
  /** guest 地址（up 时轮询 Get-VMNetworkAdapter 取得；ps 时未知）。 */
  address?: string;
  status: string;
  recipe: string;
  workspace: string;
}

export interface HypervPollControl {
  /** IP 轮询总预算（默认 HYPERV_GET_IP_TIMEOUT_MS）。 */
  deadlineMs?: number;
  /** 轮询间隔（默认 HYPERV_IP_POLL_INTERVAL_MS）。 */
  intervalMs?: number;
  /** 时钟与睡眠注入点——单测绝不真等。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HypervLifecycleOptions {
  exec?: VmExec;
  /** 实例名后缀；可注入以便测试。默认 8 位随机 hex。 */
  shortId?: () => string;
  /** 实例根目录；默认 ~/.zhishi/vm-instances-hyperv。测试传临时目录。 */
  instancesRoot?: string;
  /** 模板 Export-VM 导出目录（覆盖 recipe.vmBase）。 */
  vmBase?: string;
  /** IP 轮询控制（deadline/间隔/时钟全注入化）。 */
  ipPoll?: HypervPollControl;
  /** 平台判定注入点（Hyper-V 仅 Windows）；测试可强制 'win32'。 */
  platform?: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Pure functions — PowerShell script assembly + output parsing
// ---------------------------------------------------------------------------

/** PowerShell 单引号字符串字面量（内嵌单引号双写转义）。 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 全部命令统一走 `powershell -NoProfile -Command <script>`。 */
export function psArgs(script: string): string[] {
  return ['powershell', '-NoProfile', '-Command', script];
}

/** 在 Export-VM 导出目录下递归定位唯一配置文件（.vmcx）。 */
export function buildFindVmcxPs(exportDir: string): string {
  return `Get-ChildItem -Path ${psQuote(exportDir)} -Recurse -Filter *.vmcx | Select-Object -First 1 -ExpandProperty FullName`;
}

/**
 * Import-VM -Copy -GenerateNewId：把导出目录拷贝成一台新 VM（新 ID 防与
 * 模板/其他实例撞 GUID），磁盘/配置/快照落点统一收进 destDir，随即改名。
 */
export function buildImportVmPs(vmcxPath: string, name: string, destDir: string): string {
  const dest = psQuote(destDir);
  return (
    `$vm = Import-VM -Path ${psQuote(vmcxPath)} -Copy -GenerateNewId` +
    ` -VhdDestinationPath ${dest} -VirtualMachinePath ${dest} -SnapshotFilePath ${dest};` +
    ` Rename-VM -VM $vm -NewName ${psQuote(name)}`
  );
}

/** 快照存在性探测：存在输出 'ok'（SilentlyContinue 吞掉不存在的报错）。 */
export function buildGetSnapshotPs(name: string, snapshot: string): string {
  return `if (Get-VMSnapshot -VMName ${psQuote(name)} -Name ${psQuote(snapshot)} -ErrorAction SilentlyContinue) { 'ok' }`;
}

export function buildRestoreSnapshotPs(name: string, snapshot: string): string {
  return `Restore-VMSnapshot -Name ${psQuote(snapshot)} -VMName ${psQuote(name)} -Confirm:$false`;
}

export function buildStartVmPs(name: string): string {
  return `Start-VM -Name ${psQuote(name)}`;
}

/** guest IP 来源：Hyper-V 集成服务上报的网卡地址（可能多行/含 IPv6）。 */
export function buildGetIpPs(name: string): string {
  return `Get-VMNetworkAdapter -VMName ${psQuote(name)} | Select-Object -ExpandProperty IPAddresses`;
}

/** soft 停机（guest 内正常关机，需集成服务）；失败由调用方引导 -TurnOff。 */
export function buildStopVmPs(name: string): string {
  return `Stop-VM -Name ${psQuote(name)}`;
}

/**
 * ps 列表（ps 语义 = 运行中）：1.3.8 B4 加 State -eq 'Running' 过滤——
 * 此前无状态过滤，停止的 VM 也显示为运行中。discover 要的是全量（含
 * 停止、含非 zhishi-* 前缀），走 buildListAllVmsPs。
 * ConvertTo-Json 是可稳定解析的格式（Format-List 的对齐/本地化
 * 都不适合机器读）。单个命中时 ConvertTo-Json 输出对象而非数组——解析器
 * 两种都收。
 */
export function buildListVmsPs(): string {
  return `Get-VM -Name 'zhishi-*' | Where-Object { $_.State -eq 'Running' } | Select-Object Name, State | ConvertTo-Json -Compress`;
}

/** discover 列表（1.3.8 B5）：Get-VM 全量——不筛 zhishi-* 前缀、不筛状态。 */
export function buildListAllVmsPs(): string {
  return `Get-VM | Select-Object Name, State | ConvertTo-Json -Compress`;
}

/** 名字存在性探测：命中输出 VM 名；不存在时 Get-VM 非零退出。 */
export function buildGetVmPs(name: string): string {
  return `Get-VM -Name ${psQuote(name)} | Select-Object -ExpandProperty Name`;
}

/** rm 前的状态探测（运行中拒绝删除）。 */
export function buildGetVmStatePs(name: string): string {
  return `Get-VM -Name ${psQuote(name)} | Select-Object -ExpandProperty State`;
}

export function buildRemoveVmPs(name: string): string {
  return `Remove-VM -Name ${psQuote(name)} -Force`;
}

/**
 * 解析 `Get-VM ... | Select Name,State | ConvertTo-Json` 输出。单命中是
 * 裸对象、多命中是数组、零命中是空串；坏 JSON 返回 []（不炸整列——
 * exec 层失败由 exitCode 表达，不走这里）。
 */
export function parseHypervVmList(stdout: string): Array<{ name: string; state: string }> {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const vms: Array<{ name: string; state: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = (row as Record<string, unknown>).Name;
    const state = (row as Record<string, unknown>).State;
    if (typeof name !== 'string' || !name) continue;
    vms.push({ name, state: typeof state === 'string' ? state : String(state ?? '') });
  }
  return vms;
}

// ---------------------------------------------------------------------------
// I/O — default exec + instances root
// ---------------------------------------------------------------------------

export const HYPERV_PROBE_TIMEOUT_MS = 10_000;
export const HYPERV_IMPORT_TIMEOUT_MS = 10 * 60_000;
export const HYPERV_START_TIMEOUT_MS = 120_000;
export const HYPERV_STOP_TIMEOUT_MS = 120_000;
export const HYPERV_LIST_TIMEOUT_MS = 15_000;
/** IP 轮询总预算：guest 开机 + 集成服务上报 + DHCP，给足。 */
export const HYPERV_GET_IP_TIMEOUT_MS = 3 * 60_000;
export const HYPERV_IP_POLL_INTERVAL_MS = 3_000;

/**
 * 默认 exec：直接复用 vm-lifecycle 的 defaultVmrunExec——argv[0] 是
 * 'powershell'（非 vmrun），走 resolveCommand 的 augmented PATH 解析，
 * Hyper-V 无自定义安装路径问题（PowerShell 是系统组件）。
 */
export const defaultHypervExec: VmExec = defaultVmrunExec;

/** 默认实例根目录：~/.zhishi/vm-instances-hyperv（与 vmware 的实例目录分开）。 */
export function defaultHypervInstancesRoot(): string {
  return join(getZhiShiDataDir(), 'vm-instances-hyperv');
}

// ---------------------------------------------------------------------------
// Lifecycle operations (exec-injectable)
// ---------------------------------------------------------------------------

/**
 * hyperv 可用性前置检查：复用 E1 的 hyperv probe spec（Get-VM）+ guidance，
 * exec 注入化。返回 null = 可用，否则为用户可读的引导错误。非 Windows
 * 平台直接不可用（Hyper-V 是 Windows 特性）。
 */
export async function ensureHypervAvailable(
  exec: VmExec,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const spec = ENGINE_SPECS.find((s) => s.kind === 'hyperv');
  if (!spec) return null;
  if (platform !== 'win32') {
    return '未检测到 Hyper-V：仅 Windows 平台支持';
  }
  let probe: VmExecResult;
  try {
    probe = await exec(spec.argv, HYPERV_PROBE_TIMEOUT_MS);
  } catch (err) {
    probe = { exitCode: -1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
  const status = parseEngineProbeResult(spec, probe);
  if (status.available) return null;
  return [status.guidance, status.detail].filter(Boolean).join(' — ');
}

/** IP 轮询：deadline 内反复查网卡地址，拿到首个 IPv4 即返回。 */
async function pollGuestIp(
  name: string,
  exec: VmExec,
  control: HypervPollControl = {},
): Promise<string | undefined> {
  const now = control.now ?? (() => Date.now());
  const sleep = control.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (control.deadlineMs ?? HYPERV_GET_IP_TIMEOUT_MS);
  const interval = control.intervalMs ?? HYPERV_IP_POLL_INTERVAL_MS;
  for (;;) {
    const result = await exec(psArgs(buildGetIpPs(name)), HYPERV_LIST_TIMEOUT_MS);
    if (result.exitCode === 0 && !result.error) {
      const ip = parseGuestIp(result.stdout);
      if (ip) return ip;
    }
    if (now() >= deadline) return undefined;
    await sleep(interval);
  }
}

/**
 * hypervEnvUp：定位导出目录 .vmcx → Import-VM -Copy 成新实例 →（快照约定
 * 存在则 Restore）→ Start-VM → 轮询 guest IP。vmBase 缺失 / Hyper-V 不可用 /
 * 任一步失败都报用户可读错误；start 成功后取不到 IP 不算 up 失败（与
 * vmware 语义一致，address 缺省，open 时报未配置）。
 */
export async function hypervEnvUp(
  recipe: EnvironmentRecipe,
  workspace: string,
  options: HypervLifecycleOptions = {},
): Promise<EnvResult<{ instance: HypervInstance }>> {
  if (recipe.base !== 'vm') {
    return { ok: false, error: `配方 "${recipe.id}" 不是 VM 配方（base: ${recipe.base ?? '?'}）` };
  }

  const vmBase = options.vmBase ?? recipe.vmBase;
  if (!vmBase) {
    return {
      ok: false,
      error:
        `Hyper-V 配方 "${recipe.id}" 缺少模板。Hyper-V 模板 = Export-VM 导出目录` +
        '（在 Hyper-V 管理器里右键模板 VM → 导出）。两条路任选：\n' +
        `① 临时指定 → zhishi env up ${recipe.id} --vm-base <导出目录>；\n` +
        '② 配方 frontmatter 写 vm_base。\n' +
        '（env adopt / env build 自动养成模板暂只支持 vmware）',
    };
  }
  if (!existsSync(vmBase)) {
    return {
      ok: false,
      error: `Hyper-V 模板导出目录不存在："${vmBase}"（vm_base/--vm-base 应指向 Export-VM 导出的目录）`,
    };
  }

  const exec = options.exec ?? defaultHypervExec;

  const hypervError = await ensureHypervAvailable(exec, options.platform);
  if (hypervError) return { ok: false, error: hypervError };

  // 定位导出目录里的 .vmcx（Import-VM 的入口配置文件）。
  const findResult = await exec(psArgs(buildFindVmcxPs(vmBase)), HYPERV_LIST_TIMEOUT_MS);
  const vmcx = findResult.exitCode === 0 && !findResult.error ? findResult.stdout.trim().split('\n')[0]?.trim() : '';
  if (!vmcx) {
    return {
      ok: false,
      error:
        `导出目录 "${vmBase}" 下未找到 .vmcx 配置文件（确认这是 Export-VM 的完整导出，\n` +
        `目录下应有 Virtual Machines\\*.vmcx）：\n${outputTailOf(findResult)}`,
    };
  }

  const shortId = (options.shortId ?? (() => randomBytes(4).toString('hex')))();
  const instanceName = vmInstanceNameFor(recipe.id, shortId);
  const instancesRoot = options.instancesRoot ?? defaultHypervInstancesRoot();
  const destDir = join(instancesRoot, instanceName);
  if (existsSync(destDir)) {
    return {
      ok: false,
      error: `实例目录已存在："${destDir}"（zhishi env down ${instanceName} 后 zhishi env rm ${instanceName}，或换配方重 up）`,
    };
  }
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `创建实例目录失败（${destDir}）：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const importResult = await exec(psArgs(buildImportVmPs(vmcx, instanceName, destDir)), HYPERV_IMPORT_TIMEOUT_MS);
  if (importResult.exitCode !== 0 || importResult.error) {
    return {
      ok: false,
      error: `Import-VM 失败（模板 "${vmBase}" → 实例 "${instanceName}"）：\n${outputTailOf(importResult)}`,
    };
  }

  // 快照约定：声明的快照存在 → 先 Restore，保证每次 up 都是干净现场；
  // 不存在（首次 up / 模板未做快照）则跳过，不阻断。
  if (recipe.vmSnapshot) {
    const probeResult = await exec(psArgs(buildGetSnapshotPs(instanceName, recipe.vmSnapshot)), HYPERV_LIST_TIMEOUT_MS);
    if (probeResult.exitCode === 0 && probeResult.stdout.includes('ok')) {
      const restoreResult = await exec(
        psArgs(buildRestoreSnapshotPs(instanceName, recipe.vmSnapshot)),
        HYPERV_START_TIMEOUT_MS,
      );
      if (restoreResult.exitCode !== 0 || restoreResult.error) {
        return {
          ok: false,
          error: `Restore-VMSnapshot "${recipe.vmSnapshot}" 失败（实例 "${instanceName}"）：\n${outputTailOf(restoreResult)}`,
        };
      }
    }
  }

  const startResult = await exec(psArgs(buildStartVmPs(instanceName)), HYPERV_START_TIMEOUT_MS);
  if (startResult.exitCode !== 0 || startResult.error) {
    return {
      ok: false,
      error: `Start-VM 失败（实例 "${instanceName}"）：\n${outputTailOf(startResult)}`,
    };
  }

  const address = await pollGuestIp(instanceName, exec, options.ipPoll);
  if (!address) {
    console.warn(
      `[hyperv-lifecycle] 实例 "${instanceName}" 已启动，但未拿到 guest IP（集成服务未装/无网络？）。` +
        'env open 需要 address——guest 配好网络后手动补登 env 条目。',
    );
  }

  return {
    ok: true,
    instance: {
      id: instanceName,
      name: instanceName,
      dir: destDir,
      address,
      status: 'running',
      recipe: recipe.id,
      workspace,
    },
  };
}

/** hypervEnvDown：Stop-VM soft。实例目录保留（状态可续，删除走 rm）。 */
export async function hypervEnvDown(
  name: string,
  options: HypervLifecycleOptions = {},
): Promise<EnvResult<{ stopped: string }>> {
  const exec = options.exec ?? defaultHypervExec;

  const getResult = await exec(psArgs(buildGetVmPs(name)), HYPERV_LIST_TIMEOUT_MS);
  if (getResult.exitCode !== 0 || getResult.error || !getResult.stdout.trim()) {
    return {
      ok: false,
      error:
        `未找到 Hyper-V 实例 "${name}"（zhishi env ps 查看运行中实例；` +
        'Hyper-V 不可用时报错见上）',
    };
  }

  const stopResult = await exec(psArgs(buildStopVmPs(name)), HYPERV_STOP_TIMEOUT_MS);
  if (stopResult.exitCode !== 0 || stopResult.error) {
    return {
      ok: false,
      error:
        `Stop-VM 失败（${name}）：\n${outputTailOf(stopResult)}\n` +
        `guest 无响应时可手动 Stop-VM -Name '${name}' -TurnOff -Force（等同断电，有丢数据风险）`,
    };
  }
  return { ok: true, stopped: name };
}

/**
 * hypervEnvRm：删除已停止实例（Remove-VM -Force）+ 删实例拷贝目录。
 * 安全闸照 vmEnvRm：①名字字符白名单；②运行中拒绝（先 down）。
 */
export async function hypervEnvRm(
  name: string,
  options: HypervLifecycleOptions = {},
): Promise<EnvResult<{ removed: string }>> {
  const exec = options.exec ?? defaultHypervExec;
  const instancesRoot = options.instancesRoot ?? defaultHypervInstancesRoot();

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { ok: false, error: `非法实例名 "${name}"（仅字母数字/._-）` };
  }

  const getResult = await exec(psArgs(buildGetVmPs(name)), HYPERV_LIST_TIMEOUT_MS);
  if (getResult.exitCode !== 0 || getResult.error || !getResult.stdout.trim()) {
    return { ok: false, error: `未找到 Hyper-V 实例 "${name}"（zhishi env ps 看运行中实例）` };
  }

  const stateResult = await exec(psArgs(buildGetVmStatePs(name)), HYPERV_LIST_TIMEOUT_MS);
  if (stateResult.exitCode === 0 && /^(running|paused|starting)$/i.test(stateResult.stdout.trim())) {
    return { ok: false, error: `实例 "${name}" 还在运行——先 zhishi env down ${name}，确认不要了再 rm` };
  }

  const removeResult = await exec(psArgs(buildRemoveVmPs(name)), HYPERV_STOP_TIMEOUT_MS);
  if (removeResult.exitCode !== 0 || removeResult.error) {
    return {
      ok: false,
      error: `Remove-VM 失败（${name}）：\n${outputTailOf(removeResult)}`,
    };
  }

  const dir = join(instancesRoot, name);
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        error: `Hyper-V 实例已删除，但实例目录删除失败（${dir}）：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { ok: true, removed: name };
}

/** hypervEnvPs：Get-VM 'zhishi-*' 的运行中实例（Hyper-V 侧只列得出在册 VM）。 */
export async function hypervEnvPs(
  options: HypervLifecycleOptions = {},
): Promise<EnvResult<{ instances: HypervInstance[] }>> {
  return hypervListVms(buildListVmsPs(), options);
}

/**
 * discover 用的 Hyper-V 全量枚举（1.3.8 B5）：Get-VM 无过滤（不筛 zhishi-*
 * 前缀、不筛状态）——discover 承诺的是本机全量；会扫出用户无关 VM，与已
 * 登记条目的去重由 GUI 的 matchRegisteredEnv（1.3.7）兜住。
 */
export async function hypervEnvPsAll(
  options: HypervLifecycleOptions = {},
): Promise<EnvResult<{ instances: HypervInstance[] }>> {
  return hypervListVms(buildListAllVmsPs(), options);
}

/** ps/discover 共用的 Get-VM 列表执行 + 解析（脚本差异只在过滤口径）。 */
async function hypervListVms(
  script: string,
  options: HypervLifecycleOptions,
): Promise<EnvResult<{ instances: HypervInstance[] }>> {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { ok: false, error: 'Hyper-V 仅 Windows 平台支持' };
  }
  const exec = options.exec ?? defaultHypervExec;
  const instancesRoot = options.instancesRoot ?? defaultHypervInstancesRoot();

  const result = await exec(psArgs(script), HYPERV_LIST_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.error) {
    return {
      ok: false,
      error: `Get-VM 失败（Hyper-V 不可用？）：\n${outputTailOf(result)}`,
    };
  }
  const instances = parseHypervVmList(result.stdout).map((vm) => ({
    id: vm.name,
    name: vm.name,
    dir: join(instancesRoot, vm.name),
    status: vm.state.toLowerCase(),
    recipe: vm.name.startsWith('zhishi-') ? vm.name.split('-').slice(1, -1).join('-') : '',
    workspace: '',
  }));
  return { ok: true, instances };
}

/**
 * down/rm 路由用的名字存在性探测：容错——Hyper-V 没装 / Get-VM 失败 /
 * 名字不存在都返回 false（绝不炸路由），交给下一个引擎或 docker 兜底。
 */
export async function hypervVmExists(name: string, options: HypervLifecycleOptions = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'win32') return false;
  const exec = options.exec ?? defaultHypervExec;
  try {
    const result = await exec(psArgs(buildGetVmPs(name)), HYPERV_LIST_TIMEOUT_MS);
    return result.exitCode === 0 && !result.error && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
