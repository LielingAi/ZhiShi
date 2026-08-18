/**
 * 安全研究员版 P1 E1 — environment engine probing.
 *
 * Session startup needs to know which local execution engines exist before
 * offering containerized / VM-based environments: docker (containers),
 * Hyper-V / VirtualBox / VMware / libvirt (hypervisors), and the system ssh
 * client (remote libvirt / range access). This module probes each one with a
 * cheap CLI call and returns a structured report; engines that are missing
 * carry a one-line Chinese install/enable guidance so the UI / CLI / system
 * prompt can surface an actionable next step.
 *
 * Shape follows `provider-probe.ts`: probe specs are pure data, result
 * parsing + report aggregation are pure functions, and the only I/O lives in
 * `detectEnvironmentEngines()` behind an injectable `exec` so unit tests
 * never spawn real processes. Callers that hit this repeatedly (admin API,
 * CLI) should go through `engine-detect-cache.ts` (30s TTL).
 *
 * E1b (auto-install guidance for missing engines) lives in
 * `engine-install.ts` — it reuses ENGINE_SPECS + defaultEngineExec from here.
 */

import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { spawn as spawnSubprocess } from '../utils/subprocess';
import { resolveVmrunBinary } from './vmrun-path';

export type EnvironmentEngineKind =
  | 'docker'
  | 'hyperv'
  | 'virtualbox'
  | 'vmware'
  | 'libvirt'
  | 'ssh';

export interface EnvironmentEngineStatus {
  kind: EnvironmentEngineKind;
  available: boolean;
  /** Parsed version string when the engine is available (optional). */
  version?: string;
  /** Supplementary info (e.g. vmrun's VM count, or the failure cause). */
  detail?: string;
  /** One-line Chinese guidance shown when the engine is unavailable. */
  guidance?: string;
}

export interface EnvironmentEnginesReport {
  engines: EnvironmentEngineStatus[];
  /** docker 可用 */
  hasContainerEngine: boolean;
  /** hyperv | virtualbox | vmware | libvirt 任一可用 */
  hasHypervisor: boolean;
  hasSsh: boolean;
  /** epoch ms */
  detectedAt: number;
}

// ---------------------------------------------------------------------------
// Pure data — one probe spec per engine
// ---------------------------------------------------------------------------

export interface EngineProbeSpec {
  kind: EnvironmentEngineKind;
  /** Command line to spawn (argv[0] is resolved through the augmented PATH). */
  argv: string[];
  /** Only probeable on Windows; other platforms short-circuit to unavailable. */
  windowsOnly?: boolean;
  /** Which stream carries the version string on success. */
  versionFrom?: 'stdout' | 'stderr';
  /** When set, stdout must contain this marker in addition to exit 0. */
  stdoutMustInclude?: string;
  /** 不可用时的一句话引导。 */
  guidance: string;
}

export const ENGINE_SPECS: readonly EngineProbeSpec[] = [
  {
    kind: 'docker',
    // `docker info` fails when the daemon is down even if the CLI exists —
    // exactly the signal we want. ServerVersion doubles as the version field.
    argv: ['docker', 'info', '--format', '{{.ServerVersion}}'],
    versionFrom: 'stdout',
    guidance: '未检测到 Docker：安装 Docker Desktop（https://www.docker.com/products/docker-desktop/），需先启用 WSL2',
  },
  {
    kind: 'hyperv',
    // Get-VM requires the Hyper-V PowerShell module AND the hypervisor
    // running; the 'ok' marker guards against error text on stdout.
    argv: ['powershell', '-NoProfile', '-Command', "Get-VM | Out-Null; 'ok'"],
    windowsOnly: true,
    stdoutMustInclude: 'ok',
    guidance: '未检测到 Hyper-V：Windows 专业版以上可在「启用或关闭 Windows 功能」中勾选 Hyper-V，或管理员运行 `dism /online /enable-feature /featurename:Microsoft-Hyper-V-All /all`',
  },
  {
    kind: 'virtualbox',
    argv: ['VBoxManage', '--version'],
    versionFrom: 'stdout',
    guidance: '未检测到 VirtualBox：https://www.virtualbox.org/wiki/Downloads',
  },
  {
    kind: 'vmware',
    // `vmrun list` has no clean version output — exit 0 is the probe, the
    // "Total running VMs: N" line is surfaced as detail instead.
    argv: ['vmrun', 'list'],
    guidance: '未检测到 VMware：安装 VMware Workstation Pro（Broadcom 官网，个人使用免费）',
  },
  {
    kind: 'libvirt',
    argv: ['virsh', '--version'],
    versionFrom: 'stdout',
    guidance: '未检测到 libvirt：远程 libvirt 可经 `virsh -c qemu+ssh://...` 使用',
  },
  {
    kind: 'ssh',
    // OpenSSH prints its version to stderr, not stdout.
    argv: ['ssh', '-V'],
    versionFrom: 'stderr',
    guidance: '未检测到 ssh：Windows 设置 → 可选功能 → 添加「OpenSSH 客户端」',
  },
];

// ---------------------------------------------------------------------------
// Pure functions — parsing + aggregation (unit-tested without I/O)
// ---------------------------------------------------------------------------

/** Raw output of one probe execution. */
export interface EngineProbeOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Spawn-level error message (ENOENT etc.) when the process never ran. */
  error?: string;
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split('\n')[0]?.trim();
  return line || undefined;
}

/** Interpret one probe's raw output into a structured engine status. */
export function parseEngineProbeResult(
  spec: EngineProbeSpec,
  probe: EngineProbeOutput,
): EnvironmentEngineStatus {
  const available =
    probe.exitCode === 0 &&
    (!spec.stdoutMustInclude || probe.stdout.includes(spec.stdoutMustInclude));

  if (!available) {
    return {
      kind: spec.kind,
      available: false,
      guidance: spec.guidance,
      detail: probe.error ?? firstLine(probe.stderr) ?? firstLine(probe.stdout),
    };
  }

  const status: EnvironmentEngineStatus = { kind: spec.kind, available: true };
  if (spec.versionFrom) {
    const source = spec.versionFrom === 'stderr' ? probe.stderr : probe.stdout;
    status.version = firstLine(source);
  } else {
    // No version stream (vmrun) — keep the first stdout line as detail.
    status.detail = firstLine(probe.stdout);
  }
  return status;
}

/** Aggregate per-engine statuses into the session-facing report. */
export function aggregateEnginesReport(
  engines: EnvironmentEngineStatus[],
  detectedAt: number = Date.now(),
): EnvironmentEnginesReport {
  const available = (kind: EnvironmentEngineKind): boolean =>
    engines.some((e) => e.kind === kind && e.available);
  return {
    engines,
    hasContainerEngine: available('docker'),
    hasHypervisor: (['hyperv', 'virtualbox', 'vmware', 'libvirt'] as const).some(available),
    hasSsh: available('ssh'),
    detectedAt,
  };
}

// ---------------------------------------------------------------------------
// I/O — probe execution (exec is injectable for tests)
// ---------------------------------------------------------------------------

/** Per-engine probe timeout — a missing CLI fails fast, but a wedged daemon
 * (docker info against a stopped Docker Desktop) must not stall startup. */
export const ENGINE_PROBE_TIMEOUT_MS = 10_000;

export interface EngineExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Spawn-level error message (ENOENT etc.) when the process never ran. */
  error?: string;
}

export type EngineExec = (argv: string[], timeoutMs: number) => Promise<EngineExecResult>;

/**
 * Default exec: resolve the binary through the augmented PATH (GUI apps get
 * a minimal PATH — same reasoning as the other `resolveCommand` callers),
 * capture stdout/stderr, kill on timeout. Never throws for non-zero exits;
 * throws only on spawn-level failure or timeout.
 */
export async function defaultEngineExec(argv: string[], timeoutMs: number): Promise<EngineExecResult> {
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
      throw new Error(`probe timed out after ${timeoutMs}ms: ${argv[0]}`);
    }
    if (proc.error) {
      return { exitCode, stdout, stderr, error: proc.error.message };
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe all engines in parallel. A single engine failing (missing binary,
 * wedged daemon, timeout) degrades to `available: false` with guidance — it
 * never fails the whole report.
 */
export async function detectEnvironmentEngines(
  exec: EngineExec = defaultEngineExec,
): Promise<EnvironmentEnginesReport> {
  const engines = await Promise.all(
    ENGINE_SPECS.map(async (spec): Promise<EnvironmentEngineStatus> => {
      if (spec.windowsOnly && process.platform !== 'win32') {
        return {
          kind: spec.kind,
          available: false,
          guidance: '未检测到 Hyper-V：仅 Windows 平台支持',
        };
      }
      try {
        const result = await exec(spec.argv, ENGINE_PROBE_TIMEOUT_MS);
        return parseEngineProbeResult(spec, result);
      } catch (err) {
        return {
          kind: spec.kind,
          available: false,
          guidance: spec.guidance,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return aggregateEnginesReport(engines);
}
