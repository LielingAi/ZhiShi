/**
 * 兼容壳（最小拆 zhishi-memory-core 抽包）：工作区路径同一性判定的实现已随包
 * 迁至 packages/zhishi-memory-core/src/workspacePath.ts（记忆核的
 * research_events 按 workspace 过滤是它的主消费方）。
 * 本文件只做 re-export，保持既有 `shared/workspacePath` 引用路径零改动。
 */
export * from 'zhishi-memory-core/workspacePath';
