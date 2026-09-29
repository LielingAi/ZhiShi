/**
 * gate 单测（1.8.7 P1）：鉴权闸全行为——
 *  - disabled（含回环默认）→ 全放行；
 *  - enabled → 缺失/非法 token 401、角色不够 403、层级正确放行；
 *  - 401 不区分「没有」与「不对」（同一 status，无额外信息）；
 *  - WS query token 兜底；OPTIONS 预检放行；lastUsedAt 节流回调。
 * loadAuth/touch 全部注入，不碰真实 config.json。
 */
import { describe, expect, it, vi } from 'vitest';

import { extractBearerToken, verifyHttpAuth } from './gate';
import { hashTokenSecret, type AuthConfig, type AuthTokenEntry } from './token-store';

const SEC_RO = 'zst_' + '1'.repeat(48);
const SEC_OP = 'zst_' + '2'.repeat(48);
const SEC_RV = 'zst_' + '3'.repeat(48);

function tok(id: string, role: AuthTokenEntry['role'], secret: string): AuthTokenEntry {
  return { id, name: id, role, secretHash: hashTokenSecret(secret), createdAt: '2026-09-29T00:00:00.000Z' };
}

const ENABLED: AuthConfig = {
  enabled: true,
  tokens: [tok('tok_ro', 'readonly', SEC_RO), tok('tok_op', 'operator', SEC_OP), tok('tok_rv', 'reviewer', SEC_RV)],
};

function deps(auth: AuthConfig) {
  return { loadAuth: () => auth, touch: vi.fn() };
}

describe('auth disabled → 全放行（与 1.8.6 一字节相同）', () => {
  it('enabled=false 时任何路由无 token 也放行', () => {
    const d = deps({ enabled: false, tokens: ENABLED.tokens });
    for (const [pathname, method] of [
      ['/api/admin/auth/disable', 'POST'],
      ['/api/admin/model/set-key', 'POST'],
      ['/chat/send', 'POST'],
      ['/sessions/abc', 'DELETE'],
    ] as const) {
      const v = verifyHttpAuth({ method, pathname }, d);
      expect(v.ok, `${method} ${pathname}`).toBe(true);
    }
    expect(d.touch).not.toHaveBeenCalled();
  });

  it('无 auth 键（空配置）同样放行', () => {
    const v = verifyHttpAuth({ method: 'GET', pathname: '/sessions' }, deps({ enabled: false, tokens: [] }));
    expect(v.ok).toBe(true);
  });
});

describe('auth enabled → 开放路由仍开放', () => {
  it('GET /health 与 GET /health/ready 无 token 放行', () => {
    const d = deps(ENABLED);
    expect(verifyHttpAuth({ method: 'GET', pathname: '/health' }, d).ok).toBe(true);
    expect(verifyHttpAuth({ method: 'GET', pathname: '/health/ready' }, d).ok).toBe(true);
  });

  it('OPTIONS 预检无凭证放行（实际请求照过闸）', () => {
    const d = deps(ENABLED);
    expect(verifyHttpAuth({ method: 'OPTIONS', pathname: '/api/admin/auth/disable' }, d).ok).toBe(true);
  });
});

describe('auth enabled → 401（缺失/非法同一面目）', () => {
  it('无 Authorization 头 → 401', () => {
    const v = verifyHttpAuth({ method: 'GET', pathname: '/sessions' }, deps(ENABLED));
    expect(v).toEqual({ ok: false, status: 401 });
  });

  it('非法 token → 同一 401（不泄露哪一环失败）', () => {
    const v = verifyHttpAuth({ method: 'GET', pathname: '/sessions', authorization: 'Bearer zst_wrong' }, deps(ENABLED));
    expect(v).toEqual({ ok: false, status: 401 });
  });

  it('Authorization 头形状错误 → 401', () => {
    for (const h of ['Basic abc', 'Bearer', 'bearerzst_x', '']) {
      const v = verifyHttpAuth({ method: 'GET', pathname: '/sessions', authorization: h }, deps(ENABLED));
      expect(v.ok, JSON.stringify(h)).toBe(false);
      if (!v.ok) expect(v.status).toBe(401);
    }
  });
});

describe('auth enabled → 角色层级 enforcement', () => {
  it('readonly：只读路由放行，operator/reviewer 路由 403', () => {
    const d = deps(ENABLED);
    const auth = `Bearer ${SEC_RO}`;
    expect(verifyHttpAuth({ method: 'GET', pathname: '/chat/stream', authorization: auth }, d).ok).toBe(true);
    expect(verifyHttpAuth({ method: 'POST', pathname: '/api/admin/archive/list', authorization: auth }, d).ok).toBe(true);
    for (const [pathname, method] of [
      ['/chat/send', 'POST'],
      ['/api/admin/environment/up', 'POST'],
      ['/api/admin/archive/correct', 'POST'],
      ['/api/admin/auth/list', 'POST'],
    ] as const) {
      const v = verifyHttpAuth({ method, pathname, authorization: auth }, d);
      expect(v).toEqual({ ok: false, status: 403 });
    }
  });

  it('operator：operator 档放行，reviewer 档 403', () => {
    const d = deps(ENABLED);
    const auth = `Bearer ${SEC_OP}`;
    for (const [pathname, method] of [
      ['/chat/send', 'POST'],
      ['/api/admin/environment/exec', 'POST'],
      ['/api/admin/config/set', 'POST'],
      ['/sessions/abc', 'DELETE'],
    ] as const) {
      expect(verifyHttpAuth({ method, pathname, authorization: auth }, d).ok, pathname).toBe(true);
    }
    // B 案后 /chat/boundary/respond 的路由档降为 operator（豁免在 handler 内
    // 复核）——operator 档 403 清单不再含它，另在 operator 放行清单里钉住。
    expect(verifyHttpAuth({ method: 'POST', pathname: '/chat/boundary/respond', authorization: auth }, d).ok).toBe(true);
    for (const p of ['/api/admin/archive/correct', '/api/admin/model/set-key', '/api/admin/auth/disable']) {
      const v = verifyHttpAuth({ method: 'POST', pathname: p, authorization: auth }, d);
      expect(v, p).toEqual({ ok: false, status: 403 });
    }
  });

  it('reviewer：全档放行（含 auth/disable 与 boundary 审批）', () => {
    const d = deps(ENABLED);
    const auth = `Bearer ${SEC_RV}`;
    for (const p of ['/api/admin/auth/disable', '/api/admin/archive/correct', '/chat/boundary/respond', '/chat/decision/respond']) {
      expect(verifyHttpAuth({ method: 'POST', pathname: p, authorization: auth }, d).ok, p).toBe(true);
    }
  });

  it('锁死保护链：auth enabled 时无 reviewer token → auth/disable 到不了 handler', () => {
    const d = deps(ENABLED);
    expect(verifyHttpAuth({ method: 'POST', pathname: '/api/admin/auth/disable' }, d)).toEqual({ ok: false, status: 401 });
    expect(verifyHttpAuth({ method: 'POST', pathname: '/api/admin/auth/disable', authorization: `Bearer ${SEC_OP}` }, d)).toEqual({ ok: false, status: 403 });
  });
});

describe('WS query token 兜底 + lastUsedAt', () => {
  it('queryToken 命中放行（WS upgrade 路径）', () => {
    const d = deps(ENABLED);
    const v = verifyHttpAuth({ method: 'GET', pathname: '/api/admin/environment/term', queryToken: SEC_OP }, d);
    expect(v.ok).toBe(true);
  });

  it('readonly token 过 WS 闸 → 403（term 是 operator 档）', () => {
    const d = deps(ENABLED);
    const v = verifyHttpAuth({ method: 'GET', pathname: '/api/admin/environment/term', queryToken: SEC_RO }, d);
    expect(v).toEqual({ ok: false, status: 403 });
  });

  it('header 优先于 queryToken；成功鉴权触发 touch', () => {
    const d = deps(ENABLED);
    const v = verifyHttpAuth(
      { method: 'GET', pathname: '/sessions', authorization: `Bearer ${SEC_RV}`, queryToken: 'zst_wrong' },
      d,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.tokenId).toBe('tok_rv');
    expect(d.touch).toHaveBeenCalledWith('tok_rv');
  });
});

describe('extractBearerToken', () => {
  it('标准/大小写/多余空白形态', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('  Bearer   abc  ')).toBe('abc');
    expect(extractBearerToken(null)).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
  });
});
