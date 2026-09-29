/**
 * actor 单测（1.8.7 P2 身份贯穿）：
 *  - gate 判定的 actor：token 命中 → {name, role, source:'token'}；
 *    放行路径（disabled/开放路由/预检）→ LOCAL_ACTOR（形状统一）；
 *  - ALS 传播：withLogContext({actorName, actorRole}) → currentActor()；
 *    无帧/无字段 → LOCAL_ACTOR；
 *  - turn 起跑人登记：originatorForSession 命中登记 → ALS actor → LOCAL。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTurnOriginatorsForTests,
  currentActor,
  LOCAL_ACTOR,
  originatorForSession,
  setTurnOriginator,
} from './actor';
import { verifyHttpAuth } from './gate';
import { hashTokenSecret, type AuthConfig } from './token-store';
import { withLogContext } from '../logger-context';

const SEC = 'zst_' + '9'.repeat(48);
const ENABLED: AuthConfig = {
  enabled: true,
  tokens: [{ id: 'tok_a', name: 'alice', role: 'reviewer', secretHash: hashTokenSecret(SEC), createdAt: '2026-09-29T00:00:00.000Z' }],
};
const deps = (auth: AuthConfig) => ({ loadAuth: () => auth, touch: vi.fn() });

beforeEach(() => {
  __resetTurnOriginatorsForTests();
});

describe('verifyHttpAuth 返回 actor（P2 additive）', () => {
  it('token 命中 → actor = token 身份（name/role/source=token）', () => {
    const v = verifyHttpAuth({ method: 'GET', pathname: '/sessions', authorization: `Bearer ${SEC}` }, deps(ENABLED));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.actor).toEqual({ name: 'alice', role: 'reviewer', source: 'token' });
  });

  it('auth 关闭 → 放行且 actor = LOCAL_ACTOR（本地模式形状统一）', () => {
    const v = verifyHttpAuth({ method: 'POST', pathname: '/chat/send' }, deps({ enabled: false, tokens: [] }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.actor).toEqual(LOCAL_ACTOR);
  });

  it('开放路由/预检（enabled 但无 token）→ actor = LOCAL_ACTOR', () => {
    const v1 = verifyHttpAuth({ method: 'GET', pathname: '/health' }, deps(ENABLED));
    if (v1.ok) expect(v1.actor).toEqual(LOCAL_ACTOR);
    const v2 = verifyHttpAuth({ method: 'OPTIONS', pathname: '/api/admin/auth/disable' }, deps(ENABLED));
    if (v2.ok) expect(v2.actor).toEqual(LOCAL_ACTOR);
  });

  it('401/403 无 actor（形状不变）', () => {
    const v = verifyHttpAuth({ method: 'GET', pathname: '/sessions' }, deps(ENABLED));
    expect(v).toEqual({ ok: false, status: 401 });
  });
});

describe('currentActor（ALS 传播）', () => {
  it('无 ALS 帧 → LOCAL_ACTOR', () => {
    expect(currentActor()).toEqual(LOCAL_ACTOR);
  });

  it('ALS 帧带 actorName/actorRole → token actor', () => {
    const seen = withLogContext({ actorName: 'bob', actorRole: 'operator' }, () => currentActor());
    expect(seen).toEqual({ name: 'bob', role: 'operator', source: 'token' });
  });

  it('ALS 帧无身份字段（旧生成点）→ LOCAL_ACTOR；actorRole 非法 → 兜底 reviewer', () => {
    expect(withLogContext({ requestId: 'r1' }, () => currentActor())).toEqual(LOCAL_ACTOR);
    const weird = withLogContext({ actorName: 'bob', actorRole: 'root' }, () => currentActor());
    expect(weird).toEqual({ name: 'bob', role: 'reviewer', source: 'token' });
  });

  it('嵌套帧：内层身份覆盖、出帧恢复（merge 语义沿用 log-context）', () => {
    withLogContext({ actorName: 'alice', actorRole: 'reviewer' }, () => {
      expect(currentActor().name).toBe('alice');
      withLogContext({ actorName: 'carol', actorRole: 'operator' }, () => {
        expect(currentActor().name).toBe('carol');
      });
      expect(currentActor().name).toBe('alice');
    });
  });
});

describe('turn 起跑人登记（originatorForSession）', () => {
  it('登记后按线命中；换线互不染', () => {
    setTurnOriginator('ls-1', { name: 'alice', role: 'reviewer', source: 'token' });
    expect(originatorForSession('ls-1').name).toBe('alice');
    // 未登记的线：无 ALS → LOCAL
    expect(originatorForSession('ls-2')).toEqual(LOCAL_ACTOR);
  });

  it('未登记但 ALS 帧有身份 → 当前请求 actor（请求内直接产物）', () => {
    const seen = withLogContext({ actorName: 'bob', actorRole: 'reviewer' }, () => originatorForSession('ls-x'));
    expect(seen).toEqual({ name: 'bob', role: 'reviewer', source: 'token' });
  });

  it('登记覆盖（另一成员接线开 turn → 起跑即换人）', () => {
    setTurnOriginator('ls-1', { name: 'alice', role: 'reviewer', source: 'token' });
    setTurnOriginator('ls-1', { name: 'bob', role: 'operator', source: 'token' });
    expect(originatorForSession('ls-1').name).toBe('bob');
  });
});
