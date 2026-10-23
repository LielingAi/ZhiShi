/**
 * 兼容壳：版本解析已迁至 `src/shared/version.ts`（CLI 也要用同一份口径）。
 * 本文件保留既有 import 路径，行为零变化。
 */
export { resolveVersion as resolveSidecarVersion } from '../shared/version';
