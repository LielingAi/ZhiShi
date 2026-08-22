/**
 * Unified ZhiShi data directory resolution (Node.js side).
 *
 * This is the single source of truth for the data directory path.
 * It mirrors the resolution logic in Rust `app_dirs::zhishi_data_dir()`:
 *
 * 1. `ZHISHI_DATA_DIR` environment variable — injected by the Rust parent
 *    process when running in USB portable mode or when explicitly overridden.
 * 2. `ZHISHI_CONFIG_DIR` environment variable — legacy fallback (used by
 *    mcp-oauth/state-store.ts prior to this unification).
 * 3. Default: `join(homedir(), '.zhishi')`.
 *
 * All Node.js code that needs the ZhiShi data directory SHOULD import this
 * function instead of hard-coding `~/.zhishi`.
 */

import { homedir } from 'os';
import { join } from 'path';

export function getZhiShiDataDir(): string {
  // 1. Primary: ZHISHI_DATA_DIR (injected by Rust parent process)
  const envDataDir = process.env.ZHISHI_DATA_DIR;
  if (envDataDir) {
    return envDataDir;
  }

  // 2. Legacy fallback: ZHISHI_CONFIG_DIR
  const envConfigDir = process.env.ZHISHI_CONFIG_DIR;
  if (envConfigDir) {
    return envConfigDir;
  }

  // 3. Default home directory
  const home = homedir();
  if (!home) {
    throw new Error(
      'Unable to determine ZhiShi data directory: homedir() returned empty string. ' +
      'Please set the ZHISHI_DATA_DIR environment variable explicitly.'
    );
  }
  return join(home, '.zhishi');
}
