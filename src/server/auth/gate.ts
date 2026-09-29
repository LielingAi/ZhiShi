/**
 * 1.8.7 P1 团队大脑——鉴权闸（唯一入口，包裹全部路由：admin + 非 admin +
 * SSE；WS upgrade 由 term-pty 调同一 verifyHttpAuth）。
 *
 * 语义：
 * - auth.enabled=false（含 config.json 无 auth 键）→ 一律放行，与 1.8.6
 *   一字节相同（本机单用户路径零变化）；
 * - enabled 时除开放路由（GET /health、GET /health/ready）外都要有效
 *   token：缺失/非法 → 401（同一报错，不泄露「没有」还是「不对」）；
 *   角色不够 → 403；
 * - token 取自 `Authorization: Bearer <secret>`；WS upgrade 额外接受
 *   `?token=` query 兜底（浏览器 WebSocket 不能自定义头）——query 兜底
 *   只在 WS 路径传入，HTTP 路径调用方不传 queryToken；
 * - CORS 预检（OPTIONS）不带凭证，放行给 cors.ts 的 allowlist 处理——
 *   真正的请求仍会过闸。
 */

import { LOCAL_ACTOR, type Actor } from './actor';
import { requiredRoleFor, roleAtLeast, type AuthRole } from './roles';
import {
  findTokenBySecret,
  loadAuthConfigCached,
  touchLastUsedThrottled,
  type AuthConfig,
  type AuthConfigLoader,
} from './token-store';

export interface VerifyInput {
  method: string;
  pathname: string;
  /** Authorization 头原值（含 "Bearer " 前缀）。 */
  authorization?: string | null;
  /** query token 兜底——仅 WS upgrade 路径使用。 */
  queryToken?: string | null;
}

export interface VerifyDeps {
  /** 测试注入：auth 配置源。默认 loadAuthConfigCached（mtime 缓存）。 */
  loadAuth?: AuthConfigLoader;
  /** 测试注入：lastUsedAt 回写。默认 touchLastUsedThrottled。 */
  touch?: (tokenId: string) => void;
}

export type AuthVerdict =
  // P2：actor 恒在场（形状统一）——token 命中 = token 身份；放行路径 =
  // LOCAL_ACTOR（auth 关闭/开放路由/预检，role/tokenId=null 表示未经鉴权）。
  | { ok: true; role: AuthRole | null; tokenId: string | null; actor: Actor }
  | { ok: false; status: 401 | 403 };

/** 放行（auth 关闭 / 开放路由 / 预检）。role/tokenId=null 表示未经鉴权。 */
const OPEN_VERDICT: AuthVerdict = { ok: true, role: null, tokenId: null, actor: LOCAL_ACTOR };

/** 从 Authorization 头取 Bearer token（取不到返回 undefined）。 */
export function extractBearerToken(authorization?: string | null): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
  return m?.[1] || undefined;
}

/** 当前是否启用鉴权（CORS 判定也用它——enabled 才收紧）。 */
export function isAuthEnabled(loadAuth: AuthConfigLoader = loadAuthConfigCached): boolean {
  return loadAuth().enabled;
}

/**
 * 请求鉴权判定（同步——auth 配置走 mtime 缓存，热路径零磁盘 IO）。
 * 401=缺失/非法 token；403=token 有效但角色不够。
 */
export function verifyHttpAuth(input: VerifyInput, deps: VerifyDeps = {}): AuthVerdict {
  // CORS 预检从不带 Authorization——放行（实际请求照过闸）。
  if (input.method.toUpperCase() === 'OPTIONS') return OPEN_VERDICT;
  const auth = (deps.loadAuth ?? loadAuthConfigCached)();
  if (!auth.enabled) return OPEN_VERDICT;
  const required = requiredRoleFor(input.pathname, input.method);
  if (required === 'open') return OPEN_VERDICT;
  const secret = extractBearerToken(input.authorization) ?? (input.queryToken?.trim() || undefined);
  // 缺失与非法同一 401——不泄露哪一环失败、哪个 token 命中。
  if (!secret) return { ok: false, status: 401 };
  const entry = findTokenBySecret(auth, secret);
  if (!entry) return { ok: false, status: 401 };
  if (!roleAtLeast(entry.role, required)) return { ok: false, status: 403 };
  (deps.touch ?? touchLastUsedThrottled)(entry.id);
  return { ok: true, role: entry.role, tokenId: entry.id, actor: { name: entry.name, role: entry.role, source: 'token' } };
}
