/**
 * 兼容壳（最小拆 zhishi-loop-core 抽包）：实现已迁至
 * packages/zhishi-loop-core/src/file-lock.ts（session 持久化依赖它，
 * 随包 vendored 保持包自包含）。本文件只做 re-export，保持既有
 * `server/utils/file-lock` 引用路径零改动。
 */
export * from 'zhishi-loop-core/file-lock';
