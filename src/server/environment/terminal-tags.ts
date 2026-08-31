/**
 * 安全研究员版 P1 E6 — sidecar 进程内的 terminalId → envTag 映射。
 *
 * 注册点：admin-api 的 panel 代理（term/open 带 env 字段时登记，term/close
 * 注销）。Rust 侧 TerminalManager 是标记的持久载体，这里只是 sidecar 的
 * 查询缓存——进程重启即清空。
 * （1.5.4：唯一读取方 environment/boundary.ts 已随僵尸模块清理删除，本模块
 * 暂存注册/注销写路径；若确认无新消费方，可整模块连同 admin-api 登记点移除。）
 */

const terminalEnvTags = new Map<string, string>();

export function registerTerminalEnvTag(terminalId: string, envTag: string): void {
  if (!terminalId || !envTag) return;
  terminalEnvTags.set(terminalId, envTag);
}

export function unregisterTerminalEnvTag(terminalId: string): void {
  terminalEnvTags.delete(terminalId);
}
