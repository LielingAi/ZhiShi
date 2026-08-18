/**
 * 安全研究员版 P1 E1 — environment engine probe unit tests.
 *
 * Pure-logic coverage for spec assembly, probe-result parsing, report
 * aggregation, single-engine failure isolation, and the 30s TTL cache.
 * All exec is injected — no real subprocesses are spawned here.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  ENGINE_SPECS,
  aggregateEnginesReport,
  detectEnvironmentEngines,
  parseEngineProbeResult,
  type EngineExec,
  type EngineProbeSpec,
  type EnvironmentEngineStatus,
} from './engines';
import {
  detectEnvironmentEnginesCached,
  __resetEngineDetectCacheForTest,
} from './engine-detect-cache';

function specOf(kind: EngineProbeSpec['kind']): EngineProbeSpec {
  const spec = ENGINE_SPECS.find((s) => s.kind === kind);
  if (!spec) throw new Error(`spec missing for ${kind}`);
  return spec;
}

function ok(stdout = '', stderr = '') {
  return { exitCode: 0, stdout, stderr };
}

describe('ENGINE_SPECS — probe command assembly', () => {
  it('covers all six engine kinds exactly once', () => {
    expect(ENGINE_SPECS.map((s) => s.kind).sort()).toEqual(
      ['docker', 'hyperv', 'libvirt', 'ssh', 'virtualbox', 'vmware'],
    );
  });

  it('docker probes the daemon via `docker info --format {{.ServerVersion}}`', () => {
    expect(specOf('docker').argv).toEqual(['docker', 'info', '--format', '{{.ServerVersion}}']);
    expect(specOf('docker').versionFrom).toBe('stdout');
  });

  it('hyperv is Windows-only and requires an "ok" marker in stdout', () => {
    const spec = specOf('hyperv');
    expect(spec.windowsOnly).toBe(true);
    expect(spec.argv[0]).toBe('powershell');
    expect(spec.argv).toContain('-NoProfile');
    expect(spec.stdoutMustInclude).toBe('ok');
  });

  it('virtualbox / vmware / libvirt probe their CLIs', () => {
    expect(specOf('virtualbox').argv).toEqual(['VBoxManage', '--version']);
    expect(specOf('vmware').argv).toEqual(['vmrun', 'list']);
    expect(specOf('libvirt').argv).toEqual(['virsh', '--version']);
  });

  it('ssh reads its version from stderr (`ssh -V`)', () => {
    const spec = specOf('ssh');
    expect(spec.argv).toEqual(['ssh', '-V']);
    expect(spec.versionFrom).toBe('stderr');
  });

  it('every spec carries a Chinese guidance line for the unavailable case', () => {
    for (const spec of ENGINE_SPECS) {
      expect(spec.guidance).toMatch(/^未检测到/);
    }
  });
});

describe('parseEngineProbeResult — stdout/stderr parsing', () => {
  it('docker: exit 0 → available, stdout becomes the version', () => {
    const status = parseEngineProbeResult(specOf('docker'), ok('27.3.1\n'));
    expect(status).toEqual({ kind: 'docker', available: true, version: '27.3.1' });
  });

  it('docker: non-zero exit → unavailable with guidance + stderr detail', () => {
    const status = parseEngineProbeResult(
      specOf('docker'),
      { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
    );
    expect(status.available).toBe(false);
    expect(status.guidance).toContain('Docker Desktop');
    expect(status.detail).toContain('Cannot connect');
  });

  it('ssh: version string is read from stderr', () => {
    const status = parseEngineProbeResult(specOf('ssh'), ok('', 'OpenSSH_9.5p1, OpenSSL 3.0.13\n'));
    expect(status.available).toBe(true);
    expect(status.version).toBe('OpenSSH_9.5p1, OpenSSL 3.0.13');
  });

  it('hyperv: exit 0 without the ok marker still counts as unavailable', () => {
    const status = parseEngineProbeResult(specOf('hyperv'), ok('some error text'));
    expect(status.available).toBe(false);
    expect(status.guidance).toContain('Hyper-V');
  });

  it('hyperv: stdout containing ok → available', () => {
    const status = parseEngineProbeResult(specOf('hyperv'), ok('ok\r\n'));
    expect(status.available).toBe(true);
  });

  it('vmware: vmrun has no version stream — stdout lands in detail instead', () => {
    const status = parseEngineProbeResult(specOf('vmware'), ok('Total running VMs: 0\n'));
    expect(status.available).toBe(true);
    expect(status.version).toBeUndefined();
    expect(status.detail).toBe('Total running VMs: 0');
  });

  it('spawn failure (exitCode -1 + error) → unavailable, error surfaced as detail', () => {
    const status = parseEngineProbeResult(
      specOf('virtualbox'),
      { exitCode: -1, stdout: '', stderr: '', error: 'spawn VBoxManage ENOENT' },
    );
    expect(status.available).toBe(false);
    expect(status.detail).toBe('spawn VBoxManage ENOENT');
    expect(status.guidance).toContain('virtualbox.org');
  });
});

describe('aggregateEnginesReport — has* flags', () => {
  const st = (kind: EngineProbeSpec['kind'], available: boolean): EnvironmentEngineStatus =>
    ({ kind, available });

  it('all unavailable → all flags false', () => {
    const report = aggregateEnginesReport(ENGINE_SPECS.map((s) => st(s.kind, false)), 123);
    expect(report.hasContainerEngine).toBe(false);
    expect(report.hasHypervisor).toBe(false);
    expect(report.hasSsh).toBe(false);
    expect(report.detectedAt).toBe(123);
  });

  it('docker maps to hasContainerEngine only', () => {
    const report = aggregateEnginesReport([
      st('docker', true), st('hyperv', false), st('virtualbox', false),
      st('vmware', false), st('libvirt', false), st('ssh', false),
    ]);
    expect(report.hasContainerEngine).toBe(true);
    expect(report.hasHypervisor).toBe(false);
    expect(report.hasSsh).toBe(false);
  });

  it('any one hypervisor flips hasHypervisor', () => {
    for (const kind of ['hyperv', 'virtualbox', 'vmware', 'libvirt'] as const) {
      const report = aggregateEnginesReport(ENGINE_SPECS.map((s) => st(s.kind, s.kind === kind)));
      expect(report.hasHypervisor).toBe(true);
      expect(report.hasContainerEngine).toBe(false);
    }
  });

  it('ssh maps to hasSsh', () => {
    const report = aggregateEnginesReport(ENGINE_SPECS.map((s) => st(s.kind, s.kind === 'ssh')));
    expect(report.hasSsh).toBe(true);
    expect(report.hasHypervisor).toBe(false);
  });
});

describe('detectEnvironmentEngines — injected exec scenarios', () => {
  it('all engines available', async () => {
    const exec: EngineExec = async (argv) => {
      const cmd = argv[0];
      if (cmd === 'docker') return ok('27.3.1');
      if (cmd === 'powershell') return ok('ok');
      if (cmd === 'VBoxManage') return ok('7.0.14r161095');
      if (cmd === 'vmrun') return ok('Total running VMs: 0');
      if (cmd === 'virsh') return ok('10.0.0');
      if (cmd === 'ssh') return ok('', 'OpenSSH_9.5p1');
      throw new Error(`unexpected argv: ${argv.join(' ')}`);
    };
    const report = await detectEnvironmentEngines(exec);
    expect(report.engines.every((e) => e.available)).toBe(true);
    expect(report.hasContainerEngine).toBe(true);
    expect(report.hasHypervisor).toBe(true);
    expect(report.hasSsh).toBe(true);
    expect(report.detectedAt).toBeGreaterThan(0);
  });

  it('all engines missing (exec throws) → report still returned, all guidance set', async () => {
    const exec: EngineExec = async () => { throw new Error('ENOENT'); };
    const report = await detectEnvironmentEngines(exec);
    expect(report.engines).toHaveLength(ENGINE_SPECS.length);
    for (const engine of report.engines) {
      // hyperv on non-Windows platforms is short-circuited before exec, but
      // carries a platform note instead of install guidance — either way it
      // must be unavailable with a non-empty guidance line.
      expect(engine.available).toBe(false);
      expect(engine.guidance).toBeTruthy();
    }
    expect(report.hasContainerEngine).toBe(false);
    expect(report.hasHypervisor).toBe(false);
    expect(report.hasSsh).toBe(false);
  });

  it('one engine failure does not affect the others', async () => {
    const exec: EngineExec = async (argv) => {
      if (argv[0] === 'docker') throw new Error('spawn docker ENOENT');
      if (argv[0] === 'ssh') return ok('', 'OpenSSH_9.5p1');
      // Everything else: non-zero exit → unavailable but not throwing.
      return { exitCode: 1, stdout: '', stderr: 'not installed' };
    };
    const report = await detectEnvironmentEngines(exec);
    const docker = report.engines.find((e) => e.kind === 'docker');
    const ssh = report.engines.find((e) => e.kind === 'ssh');
    expect(docker?.available).toBe(false);
    expect(docker?.detail).toContain('ENOENT');
    expect(ssh?.available).toBe(true);
    expect(report.hasSsh).toBe(true);
    expect(report.hasContainerEngine).toBe(false);
  });

  it('hyperv is short-circuited on non-Windows platforms without calling exec', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const exec: EngineExec = vi.fn(async () => ok('ok'));
      const report = await detectEnvironmentEngines(exec);
      const hyperv = report.engines.find((e) => e.kind === 'hyperv');
      expect(hyperv?.available).toBe(false);
      expect(hyperv?.guidance).toContain('Windows');
      const calledArgv = (exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0][0]);
      expect(calledArgv).not.toContain('powershell');
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('detectEnvironmentEnginesCached — 30s TTL + single-flight', () => {
  beforeEach(() => {
    __resetEngineDetectCacheForTest();
  });

  const REPORT = aggregateEnginesReport(
    ENGINE_SPECS.map((s) => ({ kind: s.kind, available: true })),
    1,
  );

  it('caches a fresh report and reuses it within the TTL', async () => {
    const detector = vi.fn(async () => REPORT);
    await detectEnvironmentEnginesCached(detector);
    await detectEnvironmentEnginesCached(detector);
    expect(detector).toHaveBeenCalledTimes(1);
  });

  it('expires the cache after 30s', async () => {
    vi.useFakeTimers();
    try {
      const detector = vi.fn(async () => REPORT);
      await detectEnvironmentEnginesCached(detector);
      await detectEnvironmentEnginesCached(detector);
      expect(detector).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
      await detectEnvironmentEnginesCached(detector);
      expect(detector).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forceFresh bypasses the cache', async () => {
    const detector = vi.fn(async () => REPORT);
    await detectEnvironmentEnginesCached(detector);
    await detectEnvironmentEnginesCached(detector, { forceFresh: true });
    expect(detector).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent in-flight probes (single-flight)', async () => {
    let resolve!: (v: typeof REPORT) => void;
    const detector = vi.fn(() => new Promise<typeof REPORT>((r) => { resolve = r; }));

    const p1 = detectEnvironmentEnginesCached(detector);
    const p2 = detectEnvironmentEnginesCached(detector);
    expect(detector).toHaveBeenCalledTimes(1);

    resolve(REPORT);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(REPORT);
    expect(r2).toEqual(REPORT);
    expect(detector).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failed probe — next call retries', async () => {
    const failing = vi.fn(async () => { throw new Error('spawn failed'); });
    await expect(detectEnvironmentEnginesCached(failing)).rejects.toThrow('spawn failed');

    const succeeding = vi.fn(async () => REPORT);
    const result = await detectEnvironmentEnginesCached(succeeding);
    expect(result).toEqual(REPORT);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
