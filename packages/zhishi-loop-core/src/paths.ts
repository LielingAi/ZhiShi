/**
 * ZhiShi 数据目录解析（包内 vendored 副本）。
 *
 * 与 src/shared/app-dirs.ts 的 getZhiShiDataDir 保持同一约定：
 *   1. ZHISHI_DATA_DIR 环境变量（Rust 父进程注入，便携模式）
 *   2. ZHISHI_CONFIG_DIR 环境变量（legacy fallback）
 *   3. 缺省 join(homedir(), '.zhishi')
 *
 * 单一事实源在 src/shared/app-dirs.ts——本文件是包自包含所需的镜像；
 * 约定变更时两边同步（该约定是稳定路径规则，漂移面极小）。
 */

import { homedir } from 'os';
import { join } from 'path';

export function getZhiShiDataDir(): string {
  const envDataDir = process.env.ZHISHI_DATA_DIR;
  if (envDataDir) {
    return envDataDir;
  }

  const envConfigDir = process.env.ZHISHI_CONFIG_DIR;
  if (envConfigDir) {
    return envConfigDir;
  }

  const home = homedir();
  if (!home) {
    throw new Error(
      'Unable to determine ZhiShi data directory: homedir() returned empty string. ' +
        'Please set the ZHISHI_DATA_DIR environment variable explicitly.',
    );
  }
  return join(home, '.zhishi');
}
