/**
 * 兼容壳（1.2.3，issue #5）：实现已迁至 src/shared/domain-manifest.ts
 * （TUI signal-extract 与 server 共用域包清单层）。本文件只做 re-export，
 * 保持既有 `server/domains/manifest` 引用路径（admin-api / skills-config /
 * bundled-agents / expert/seed / 单测）零改动。
 */
export * from '../../shared/domain-manifest';
