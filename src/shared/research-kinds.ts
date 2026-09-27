/**
 * 兼容壳（最小拆 zhishi-memory-core 抽包）：研究成败信号枚举的实现已随包迁至
 * packages/zhishi-memory-core/src/research-kinds.ts（记忆核是它的主消费方）。
 * 本文件只做 re-export，保持既有 `shared/research-kinds` 引用路径零改动
 * （CLI / server 两侧消费方）。
 */
export * from 'zhishi-memory-core/research-kinds';
