/**
 * 兼容壳（1.2.3，issue #5）：实现已迁至 src/shared/app-dirs.ts（CLI 也合法
 * 需要数据目录解析）。本文件只做 re-export，保持既有 `server/utils/app-dirs`
 * 引用路径零改动。
 */
export * from '../../shared/app-dirs';
