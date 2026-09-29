/**
 * 1.8.7 P1 团队大脑——auth 管理面（POST /api/admin/auth/*，全部 reviewer-only，
 * 角色分类见 ./roles.ts）。
 *
 * - list   ：tokens 元信息（id/name/role/createdAt/lastUsedAt）——**绝不回传
 *            secretHash**；
 * - add    ：生成 secret，响应里只出现这一次（服务端只存 SHA-256 哈希）；
 * - revoke ：按 id 删除；
 * - enable ：启用鉴权；零 token 时拒绝（防把自己锁在门外）；
 * - disable：关闭鉴权。防锁死保护不在此处——auth.enabled=true 时本路由是
 *            reviewer-only，没有有效 reviewer token 的请求在 HTTP 闸就被
 *            401/403 挡掉，根本到不了 handler；disabled 状态下调用是幂等
 *            no-op。
 *
 * 测试纪律：modify/load 可注入（内存 config），单测不碰真实 config.json。
 */

import { randomBytes } from 'crypto';

import { atomicModifyConfig, type AdminAppConfig } from '../utils/admin-config';
import { isAuthRole, type AuthRole } from './roles';
import {
  generateTokenSecret,
  hashTokenSecret,
  loadAuthConfig,
  normalizeAuthConfig,
  type AuthTokenEntry,
} from './token-store';

export interface AuthAdminDeps {
  modify?: typeof atomicModifyConfig;
  load?: () => AdminAppConfig;
}

type AuthAdminResponse = Record<string, unknown> & { success: boolean };

/** 公开展示形态——剥掉 secretHash。 */
function publicToken(t: AuthTokenEntry): Record<string, unknown> {
  const { secretHash: _drop, ...rest } = t;
  return rest;
}

export function handleAuthList(deps: AuthAdminDeps = {}): AuthAdminResponse {
  const auth = loadAuthConfig(deps.load);
  return {
    success: true,
    data: { enabled: auth.enabled, tokens: auth.tokens.map(publicToken) },
  };
}

export async function handleAuthAdd(
  payload: { name?: unknown; role?: unknown },
  deps: AuthAdminDeps = {},
): Promise<AuthAdminResponse> {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const role = typeof payload.role === 'string' ? payload.role.trim() : '';
  if (!name) return { success: false, error: 'Missing required field: name' };
  if (!isAuthRole(role)) {
    return { success: false, error: `非法 role "${role}"（允许：readonly / operator / reviewer）` };
  }
  const secret = generateTokenSecret();
  const entry: AuthTokenEntry = {
    id: `tok_${randomBytes(6).toString('hex')}`,
    name,
    role: role as AuthRole,
    secretHash: hashTokenSecret(secret),
    createdAt: new Date().toISOString(),
  };
  await (deps.modify ?? atomicModifyConfig)((c) => {
    const auth = normalizeAuthConfig(c.auth);
    auth.tokens.push(entry);
    c.auth = auth;
    return c;
  });
  return {
    success: true,
    data: { ...publicToken(entry), secret },
    hint: 'secret 仅此一次返回（服务端只存 SHA-256 哈希）——请立即保存，客户端用 --token / ZHISHI_TOKEN 携带。',
  };
}

export async function handleAuthRevoke(
  payload: { id?: unknown },
  deps: AuthAdminDeps = {},
): Promise<AuthAdminResponse> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) return { success: false, error: 'Missing required field: id' };
  let found = false;
  await (deps.modify ?? atomicModifyConfig)((c) => {
    const auth = normalizeAuthConfig(c.auth);
    const before = auth.tokens.length;
    auth.tokens = auth.tokens.filter((t) => t.id !== id);
    found = auth.tokens.length !== before;
    c.auth = auth;
    return c;
  });
  return found
    ? { success: true, data: { id } }
    : { success: false, error: `token '${id}' 不存在` };
}

export async function handleAuthEnable(deps: AuthAdminDeps = {}): Promise<AuthAdminResponse> {
  // 零 token 启用 = 全量 401 锁死（连 auth/disable 都进不来）——硬拒绝。
  if (loadAuthConfig(deps.load).tokens.length === 0) {
    return {
      success: false,
      error: '没有可用 token——先 `zhishi auth add --name <名字> --role reviewer` 再 enable（防零 token 锁死）。',
    };
  }
  await (deps.modify ?? atomicModifyConfig)((c) => {
    const auth = normalizeAuthConfig(c.auth);
    auth.enabled = true;
    c.auth = auth;
    return c;
  });
  return { success: true, data: { enabled: true } };
}

export async function handleAuthDisable(deps: AuthAdminDeps = {}): Promise<AuthAdminResponse> {
  await (deps.modify ?? atomicModifyConfig)((c) => {
    const auth = normalizeAuthConfig(c.auth);
    auth.enabled = false;
    c.auth = auth;
    return c;
  });
  return { success: true, data: { enabled: false } };
}
