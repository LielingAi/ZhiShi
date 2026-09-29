/**
 * 1.8.7 P1 团队大脑——sidecar 绑址参数化（默认 127.0.0.1，一字节不变）。
 *
 * 纯函数模块（unit 池可测）：优先级 --host 旗标 > ZHISHI_HOST 环境变量 >
 * 默认回环。安全闸（非回环必须启用鉴权）的判定函数也在这里，index.ts
 * 启动期调用——该 API 能 docker exec / 改配置，零鉴权监听外网等于给
 * 局域网发 root（设计稿 R1）。
 */

/** 解析有效绑址：--host 旗标 > ZHISHI_HOST > 127.0.0.1。空串按未设处理。 */
export function resolveBindHost(flagHost: string | null | undefined, envHost: string | undefined): string {
  const flag = flagHost?.trim();
  if (flag) return flag;
  const env = envHost?.trim();
  if (env) return env;
  return '127.0.0.1';
}

/**
 * 回环判定：127.0.0.0/8（不止 127.0.0.1）、::1、localhost（含 *.localhost）。
 * 用于两处：① 启动安全闸（非回环无鉴权拒绝绑定）；② CORS allowlist
 * （回环 http(s) origin 放行）。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('127.');
}
