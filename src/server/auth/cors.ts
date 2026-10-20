/**
 * 1.8.7 P1 团队大脑——CORS 策略（2.0.6 起：auth 模式下从 allowlist 阻断
 * 回退为「回显 + 审计」，真正的门是 token）。
 *
 * 回退原因（实机事故，2026-10-20）：auth.enabled=true 时预检走 allowlist，
 * 而 Tauri webview 的实际 origin 形态**不可跨版本/平台枚举**——白名单没命中
 * 就 403，浏览器把正式请求全部掐死，表现为 GUI「一直连接中」（本地/远端
 * 模式同死；auth disable 立即恢复）。allowlist 从「保护」变成「锁死自家
 * 客户端」。
 *
 * 安全模型（为什么回显不降级）：鉴权闸的门是 Authorization token——恶意
 * 网页拿不到 token，除开放路由（GET /health、/health/ready）外一律 401；
 * CORS 原本只是纵深防御的备份，不该成为主门。`isAllowedBrowserOrigin`
 * 保留（审计/单测/将来若要按 origin 分级时复用），运行时不再承担阻断。
 *
 * 语义：
 * - auth disabled → 与 1.8.6 逐字节一致（预检 ACAO:*）；
 * - auth enabled → 预检回显任意 origin（无 Origin 头仍 403——浏览器预检必带
 *   Origin，缺失即非浏览器客户端）；响应 ACAO 回显任意 origin + Vary。
 * - 无 Origin（CLI / Rust 代理）：CORS 不适用，原样返回。
 */

import { isLoopbackHost } from './bind-host';

const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';

/** Origin 是否在「预期客户端形态」清单（审计用；2.0.6 起不再参与阻断）。 */
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
 * 回显请求 Origin（见模块头：token 才是真门）。无 Origin 头 → 403。
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
  if (!originHeader) return new Response(null, { status: 403 });
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
 * auth enabled → 回显任意 Origin（2.0.6：allowlist 阻断曾把自家 GUI 锁死，
 * 见模块头；token 缺照样 401）。无 Origin 头 = 非浏览器客户端（CLI / Rust
 * 代理 / curl）——CORS 不适用，原样返回。
 */
export function applyCorsDecision(originHeader: string | null, authEnabled: boolean, response: Response): Response {
  if (!authEnabled || !originHeader) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', originHeader);
  headers.set('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
