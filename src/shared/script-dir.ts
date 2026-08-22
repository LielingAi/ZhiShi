/**
 * 运行时脚本目录定位（import.meta.url 运行期求值，不是编译期常量）。
 *
 * 1.2.3 起从 server/utils/runtime.ts 迁至 shared（issue #5）：CLI 与 server
 * 都合法需要宿主资源定位（bundled-domains / skills 等目录解析）。本文件是
 * 该能力的唯一入口——bun/esbuild 构建会在编译期硬编码 __dirname，所以必须
 * 走 import.meta.url。
 *
 * 依赖方：server/utils/runtime.ts（re-export 保持既有路径）、
 * shared/domain-manifest.ts（bundled-domains 解析）。
 */

import { dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Get script directory at runtime (not compile-time).
 * IMPORTANT: bun build hardcodes __dirname at compile time, breaking production builds.
 * This function uses import.meta.url which is evaluated at runtime.
 */
export function getScriptDir(): string {
  // For ESM modules: use import.meta.url
  if (typeof import.meta?.url === 'string') {
    return dirname(fileURLToPath(import.meta.url));
  }
  // Fallback for bundled environments - use cwd
  // NOTE: In production, sidecar.rs sets cwd to Resources directory
  console.warn('[getScriptDir] import.meta.url unavailable, falling back to cwd:', process.cwd());
  return process.cwd();
}
