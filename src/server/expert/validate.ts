/**
 * 兼容壳（1.2.3，issue #5）：实现已迁至 src/shared/expert-validate.ts
 * （CLI 与 server 共用单点校验）。本文件只做 re-export，保持既有
 * `server/expert/validate` 引用路径（admin-api / loop / 各测试）零改动。
 */
export * from '../../shared/expert-validate';
