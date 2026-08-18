/**
 * vmrun 二进制解析：PATH 优先，Windows 注册表 InstallPath 兜底。
 *
 * 背景（2026-08-15 实测）：VMware Workstation 装在自定义路径（如 D:\vm\）
 * 时不会进 PATH，`vmrun list` 探测误报「未检测到 VMware」。Workstation
 * 安装器必写注册表 InstallPath（WOW6432Node 与原生 hive 都查），从那里
 * 取 vmrun.exe 全路径即可。
 *
 * 结果进程级缓存：安装状态不会在 sidecar 生命周期内变化。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCommand } from '../utils/env-utils';

/** 解析 `reg query <hive> /v InstallPath` 的输出为安装目录；未命中返回 undefined。 */
export function parseRegInstallPath(output: string): string | undefined {
  const match = output.match(/InstallPath\s+REG(?:_EXPAND)?_SZ\s+(.+)/);
  const value = match?.[1]?.trim();
  return value || undefined;
}

/** Windows 注册表里 Workstation InstallPath 的候选 hive。 */
export const VMWARE_REGISTRY_HIVES: readonly string[] = [
  'HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation',
  'HKLM\\SOFTWARE\\VMware, Inc.\\VMware Workstation',
];

let cached: string | undefined;

/**
 * 返回 vmrun 可执行路径。PATH 上有 → 解析路径；否则 Windows 注册表兜底；
 * 都没有 → 原样返回 'vmrun'（让 spawn 以清晰的 ENOENT 失败）。
 */
export function resolveVmrunBinary(): string {
  if (cached) return cached;

  const onPath = resolveCommand('vmrun');
  if (onPath !== 'vmrun' && existsSync(onPath)) {
    cached = onPath;
    return cached;
  }

  if (process.platform === 'win32') {
    for (const hive of VMWARE_REGISTRY_HIVES) {
      try {
        const out = execFileSync('reg', ['query', hive, '/v', 'InstallPath'], {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 5_000,
        });
        const installPath = parseRegInstallPath(out);
        if (!installPath) continue;
        const candidate = join(installPath, 'vmrun.exe');
        if (existsSync(candidate)) {
          cached = candidate;
          return cached;
        }
      } catch {
        continue; // hive 不存在 / reg 不可用 → 下一个
      }
    }
  }

  cached = 'vmrun';
  return cached;
}

/** 测试钩子：清缓存（进程内安装状态变化的唯一合法时机是测试）。 */
export function resetVmrunBinaryCacheForTest(): void {
  cached = undefined;
}
