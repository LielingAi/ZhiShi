/**
 * VBoxManage 二进制解析：PATH 优先，Windows 注册表 InstallDir 兜底。
 *
 * 与 vmrun-path.ts 同一模式（背景一致）：VirtualBox 默认装在
 * `C:\Program Files\Oracle\VirtualBox\`，安装器写注册表
 * `HKLM\SOFTWARE\Oracle\VirtualBox` 的 InstallDir，但不一定进 PATH
 * （尤其 GUI 进程的精简 PATH）。从 InstallDir 拼 VBoxManage.exe 即可。
 *
 * 结果进程级缓存：安装状态不会在 sidecar 生命周期内变化。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCommand } from '../utils/env-utils';

/** 解析 `reg query <hive> /v InstallDir` 的输出为安装目录；未命中返回 undefined。 */
export function parseRegInstallDir(output: string): string | undefined {
  const match = output.match(/InstallDir\s+REG(?:_EXPAND)?_SZ\s+(.+)/);
  const value = match?.[1]?.trim();
  return value || undefined;
}

/** Windows 注册表里 VirtualBox InstallDir 的候选 hive（WOW6432Node 与原生都查）。 */
export const VIRTUALBOX_REGISTRY_HIVES: readonly string[] = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Oracle\\VirtualBox',
  'HKLM\\SOFTWARE\\Oracle\\VirtualBox',
];

let cached: string | undefined;

/**
 * 返回 VBoxManage 可执行路径。PATH 上有 → 解析路径；否则 Windows 注册表
 * 兜底；都没有 → 原样返回 'VBoxManage'（让 spawn 以清晰的 ENOENT 失败）。
 */
export function resolveVBoxManageBinary(): string {
  if (cached) return cached;

  const onPath = resolveCommand('VBoxManage');
  if (onPath !== 'VBoxManage' && existsSync(onPath)) {
    cached = onPath;
    return cached;
  }

  if (process.platform === 'win32') {
    for (const hive of VIRTUALBOX_REGISTRY_HIVES) {
      try {
        const out = execFileSync('reg', ['query', hive, '/v', 'InstallDir'], {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 5_000,
        });
        const installDir = parseRegInstallDir(out);
        if (!installDir) continue;
        const candidate = join(installDir, 'VBoxManage.exe');
        if (existsSync(candidate)) {
          cached = candidate;
          return cached;
        }
      } catch {
        continue; // hive 不存在 / reg 不可用 → 下一个
      }
    }
  }

  cached = 'VBoxManage';
  return cached;
}

/** 测试钩子：清缓存（进程内安装状态变化的唯一合法时机是测试）。 */
export function resetVBoxManageBinaryCacheForTest(): void {
  cached = undefined;
}
