/**
 * Shared utilities for logging system
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { ensureDirSync } from './utils/fs-utils';
import { getZhiShiDataDir } from './utils/app-dirs';

export const ZHISHI_DIR = getZhiShiDataDir();
export const LOGS_DIR = join(ZHISHI_DIR, 'logs');
// Retention policy moved to `./log-retention.ts` (#121, 2026-05). Keeping a
// re-export of LOGS_DIR + ensureLogsDir as the only API of this module.

/**
 * Ensure logs directory exists
 */
export function ensureLogsDir(): void {
  if (!existsSync(ZHISHI_DIR)) {
    ensureDirSync(ZHISHI_DIR);
  }
  if (!existsSync(LOGS_DIR)) {
    ensureDirSync(LOGS_DIR);
  }
}
