/**
 * 1.8.7 P1 团队大脑——token 存储（config.json `auth` 键）。
 *
 * 形状：{ enabled: boolean, tokens: [{ id, name, role, secretHash, createdAt,
 * lastUsedAt? }] }。secretHash = SHA-256(secret) 的 hex——**绝不落盘明文
 * token**；secret 只在 `auth add` 响应里出现一次。
 *
 * 读写纪律：沿用 admin-config 的 loadConfig / atomicModifyConfig（文件锁 +
 * tmp+rename + .bak），不另起存储。纯函数（normalize/hash/find）与 IO
 * 分离——单测注入内存 load/modify，不碰真实 config.json。
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { statSync } from 'fs';
import { resolve } from 'path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { atomicModifyConfig, loadConfig, type AdminAppConfig } from '../utils/admin-config';
import { isAuthRole, type AuthRole } from './roles';

export interface AuthTokenEntry {
  id: string;
  name: string;
  role: AuthRole;
  /** SHA-256(secret) hex——明文 secret 绝不落盘。 */
  secretHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface AuthConfig {
  enabled: boolean;
  tokens: AuthTokenEntry[];
}

/** 解析 config.json 的 auth 键（容错：坏形状按空配置处理，不炸请求路径）。 */
export function normalizeAuthConfig(raw: unknown): AuthConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const tokens: AuthTokenEntry[] = [];
  if (Array.isArray(r.tokens)) {
    for (const t of r.tokens) {
      const e = (t ?? {}) as Record<string, unknown>;
      if (
        typeof e.id === 'string' && e.id &&
        typeof e.name === 'string' &&
        typeof e.role === 'string' && isAuthRole(e.role) &&
        typeof e.secretHash === 'string' && /^[a-f0-9]{64}$/.test(e.secretHash) &&
        typeof e.createdAt === 'string'
      ) {
        tokens.push({
          id: e.id,
          name: e.name,
          role: e.role,
          secretHash: e.secretHash,
          createdAt: e.createdAt,
          ...(typeof e.lastUsedAt === 'string' ? { lastUsedAt: e.lastUsedAt } : {}),
        });
      }
    }
  }
  return { enabled: r.enabled === true, tokens };
}

/** 生成一次性 secret（`zst_` + 48 hex = 192 bit 熵）。只展示一次，只存哈希。 */
export function generateTokenSecret(): string {
  return `zst_${randomBytes(24).toString('hex')}`;
}

/** secret → SHA-256 hex（存储形态）。 */
export function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 按 secret 找 token（timing-safe 比较，防时序侧信道逐字节猜 hash）。 */
export function findTokenBySecret(auth: AuthConfig, secret: string): AuthTokenEntry | undefined {
  const hash = Buffer.from(hashTokenSecret(secret), 'hex');
  return auth.tokens.find((t) => {
    const h = Buffer.from(t.secretHash, 'hex');
    return h.length === hash.length && timingSafeEqual(h, hash);
  });
}

// ---------------------------------------------------------------------------
// IO（默认实现走真实 config.json；测试注入内存版本）
// ---------------------------------------------------------------------------

export type AuthConfigLoader = () => AuthConfig;

/** 从 config.json 读 auth 配置（load 可注入，默认 admin-config.loadConfig）。 */
export function loadAuthConfig(load: () => AdminAppConfig = loadConfig): AuthConfig {
  return normalizeAuthConfig((load() as Record<string, unknown>).auth);
}

// 每请求读盘太贵——按 mtime+size 做进程内缓存（config 变更无论是本进程
// atomicModifyConfig 还是外部编辑，mtime 都会变，缓存即失效；statSync 一次
// 几 µs）。原子写（tmp+rename）保证 stat 到的永远是完整文件。
let _cache: { mtimeMs: number; size: number; value: AuthConfig } | null = null;

export function loadAuthConfigCached(): AuthConfig {
  try {
    const p = resolve(getZhiShiDataDir(), 'config.json');
    const st = statSync(p);
    if (_cache && _cache.mtimeMs === st.mtimeMs && _cache.size === st.size) return _cache.value;
    const value = loadAuthConfig();
    _cache = { mtimeMs: st.mtimeMs, size: st.size, value };
    return value;
  } catch {
    // config.json 不存在/不可读 = 未配置 auth = 关闭（与现状一字节相同）。
    return { enabled: false, tokens: [] };
  }
}

/** 测试用：清进程内缓存。 */
export function resetAuthConfigCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// lastUsedAt 回写（节流）
// ---------------------------------------------------------------------------

// config 写 = 文件锁 + fsync，每请求写太贵——同一 token 5 分钟内只回写一次
// （lastUsedAt 是审计信息，分钟级精度足够），fire-and-forget 不阻塞请求。
const LAST_USED_THROTTLE_MS = 5 * 60_000;
const lastUsedWrites = new Map<string, number>();

export function touchLastUsedThrottled(tokenId: string, now: () => number = Date.now): void {
  const t = now();
  if (t - (lastUsedWrites.get(tokenId) ?? 0) < LAST_USED_THROTTLE_MS) return;
  lastUsedWrites.set(tokenId, t);
  void atomicModifyConfig((c) => {
    const auth = normalizeAuthConfig(c.auth);
    const entry = auth.tokens.find((x) => x.id === tokenId);
    if (entry) {
      entry.lastUsedAt = new Date(t).toISOString();
      c.auth = auth;
    }
    return c;
  }).catch((err) => {
    console.warn('[auth] lastUsedAt 回写失败（非致命）:', err instanceof Error ? err.message : String(err));
  });
}

/** 测试用：清节流表。 */
export function resetLastUsedThrottle(): void {
  lastUsedWrites.clear();
}
