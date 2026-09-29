/**
 * 1.8.7 P1 团队大脑——CORS 收紧（仅 auth.enabled=true 时生效；disabled 时
 * 逐字节保持 1.8.6 的 ACAO:* 行为）。
 *
 * 收紧动机：监听非回环后，浏览器里的恶意网页可以向 sidecar 发跨域请求；
 * 带 Authorization 头的请求必触发预检，预检不回 ACAO 即被浏览器拦死。
 *
 * allowlist（实机核对的客户端形态）：
 * - Tauri webview 原生 fetch（/refs/ 大值取回走 WebKit，不经 Rust 代理）：
 *   `tauri://localhost`（macOS）/ `http(s)://tauri.localhost`（Windows）；
 * - 回环 http(s) origin（任意端口）：浏览器 dev（vite）+ 回环直连。
 * 注意 Tauri 客户端的 /api/*、/sessions/*、/chat/stream 全部经 Rust
 * local_http 代理转发（server→server，无 Origin 头）——CORS 对它们不适用，
 * 鉴权靠 token 不靠 origin。
 *
 * 纯函数模块（unit 池可测）：Response 改写也在这里，index.ts 只调。
 */

import { isLoopbackHost } from './bind-host';

const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';

/** Origin 是否在 allowlist 内。 */
export function isAllowedBrowserOrigin(origin: string): boolean {
  const o = origin.trim();
  if (!o) return false;
  // Tauri webview 的 origin 形态（/refs/ 直取只走这条）。
  if (o === 'tauri://localhost' || o === 'http://tauri.localhost' || o === 'https://tauri.localhost') return true;
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * CORS 预检响应。auth disabled → 与现状逐字节一致（ACAO:*）；enabled →
 * 仅 allowlist origin 回 ACAO（echo + Vary），其余 403 且无 CORS 头
 * （浏览器据此拦掉后续真实请求）。
 */
export function preflightResponse(originHeader: string | null, authEnabled: boolean): Response {
  if (!authEnabled) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
      },
    });
  }
  if (!originHeader || !isAllowedBrowserOrigin(originHeader)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': originHeader,
      'Access-Control-Allow-Methods': ALLOW_METHODS,
      'Access-Control-Allow-Headers': ALLOW_HEADERS,
      'Vary': 'Origin',
    },
  });
}

/**
 * 响应 ACAO 改写（套在 fetch handler 最外层，覆盖 jsonResponse / SSE /
 * /refs 文件响应里硬编码的 ACAO:*）。auth disabled → 原样返回（零变化）。
 * 无 Origin 头 = 非浏览器客户端（CLI / Rust 代理 / curl）——CORS 不适用，
 * 原样返回。
 */
export function applyCorsDecision(originHeader: string | null, authEnabled: boolean, response: Response): Response {
  if (!authEnabled || !originHeader) return response;
  const headers = new Headers(response.headers);
  if (isAllowedBrowserOrigin(originHeader)) {
    headers.set('Access-Control-Allow-Origin', originHeader);
    headers.set('Vary', 'Origin');
  } else {
    // 非 allowlist origin：摘掉 ACAO，浏览器读不到响应（预检阶段已 403，
    // 这里是简单请求/直发的双保险）。
    headers.delete('Access-Control-Allow-Origin');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
