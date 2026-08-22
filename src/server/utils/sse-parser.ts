/**
 * 兼容壳（1.2.3，issue #5）：实现已迁至 src/shared/sse-parser.ts（CLI TUI
 * 与 server 共用 SSE 增量解析器）。本文件只做 re-export，保持既有
 * `server/utils/sse-parser` 引用路径零改动。
 */
export * from '../../shared/sse-parser';
