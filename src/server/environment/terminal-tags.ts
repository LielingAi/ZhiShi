/**
 * 安全研究员版 P1 E6 — sidecar 进程内的 terminalId → envTag 映射。
 *
 * 注册点：admin-api 的 panel 代理（term/open 带 env 字段时登记，term/close
 * 注销）；消费点：agent-session 的边界门控把 lookupTerminalEnvTag 注入
 * classifyBoundary。Rust 侧 TerminalManager 是标记的持久载体，这里只是
 * sidecar 的查询缓存——进程重启即清空，查不到的终端按 host 处理（保守，
 * 落现有确认流），不会因此误放行。
 */

const terminalEnvTags = new Map<string, string>();

export function registerTerminalEnvTag(terminalId: string, envTag: string): void {
  if (!terminalId || !envTag) return;
  terminalEnvTags.set(terminalId, envTag);
}

export function lookupTerminalEnvTag(terminalId: string): string | undefined {
  return terminalEnvTags.get(terminalId);
}

export function unregisterTerminalEnvTag(terminalId: string): void {
  terminalEnvTags.delete(terminalId);
}
