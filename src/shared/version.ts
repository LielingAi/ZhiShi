/**
 * 版本解析——sidecar 与 CLI 共用的单一事实源。
 *
 * 消费方：
 *  - sidecar `/health`（liveness 里带版本）与 admin 的 `version` 路由；
 *  - CLI/TUI 启动时比对「已存在的 sidecar 版本」与「自己」，防协议漂移。
 *
 * 解析顺序：
 *   1. esbuild 注入的 `__ZHISHI_VERSION__`（发行 bundle）；
 *   2. `npm_package_version`（dev 下经 npm 脚本启动时存在）；
 *   3. `ZHISHI_VERSION` 环境变量（构建系统 / 测试覆盖）；
 *   4. `'dev'` 哨兵——显式表明未打戳构建，而不是一个会撒谎的旧版本号
 *      （issue #149）。
 */

declare const __ZHISHI_VERSION__: string | undefined;

export function resolveVersion(): string {
  return (typeof __ZHISHI_VERSION__ !== 'undefined' ? __ZHISHI_VERSION__ : undefined)
    ?? process.env.npm_package_version
    ?? process.env.ZHISHI_VERSION
    ?? 'dev';
}
