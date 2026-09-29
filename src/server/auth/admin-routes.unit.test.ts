/**
 * auth 管理面单测（1.8.7 P1）：add/list/revoke/enable/disable——
 * 内存 config 注入，不碰真实 config.json。
 * 核心断言：secret 只在 add 响应出现一次，落盘的只有 SHA-256 哈希；
 * enable 零 token 拒绝（防锁死）；list 不回传哈希。
 */
import { describe, expect, it } from 'vitest';

import type { AdminAppConfig } from '../utils/admin-config';
import {
  handleAuthAdd,
  handleAuthDisable,
  handleAuthEnable,
  handleAuthList,
  handleAuthRevoke,
  type AuthAdminDeps,
} from './admin-routes';
import { hashTokenSecret } from './token-store';

function makeDeps(initialAuth?: unknown): { config: AdminAppConfig; deps: AuthAdminDeps } {
  const config: AdminAppConfig = initialAuth === undefined ? {} : { auth: initialAuth };
  return {
    config,
    deps: {
      load: () => config,
      modify: async (modifier) => modifier(config),
    },
  };
}

describe('auth/add', () => {
  it('生成 secret 返回一次；config 只存哈希（全文无明文 secret）', async () => {
    const { config, deps } = makeDeps();
    const r = await handleAuthAdd({ name: '研究员A', role: 'reviewer' }, deps);
    expect(r.success).toBe(true);
    const data = r.data as { id: string; role: string; secret: string; secretHash?: string };
    expect(data.secret).toMatch(/^zst_[a-f0-9]{48}$/);
    expect(data.secretHash).toBeUndefined(); // 响应公开面不带哈希字段
    const auth = config.auth as { enabled: boolean; tokens: Array<Record<string, unknown>> };
    expect(auth.tokens).toHaveLength(1);
    expect(auth.tokens[0].secretHash).toBe(hashTokenSecret(data.secret));
    expect(JSON.stringify(config)).not.toContain(data.secret);
  });

  it('缺 name / 非法 role → 拒绝且不写盘', async () => {
    const { config, deps } = makeDeps();
    expect((await handleAuthAdd({ role: 'reviewer' }, deps)).success).toBe(false);
    expect((await handleAuthAdd({ name: 'A', role: 'admin' }, deps)).success).toBe(false);
    expect(config.auth).toBeUndefined();
  });
});

describe('auth/list', () => {
  it('返回 enabled + tokens 元信息，无 secretHash', async () => {
    const { deps } = makeDeps();
    const added = await handleAuthAdd({ name: 'A', role: 'operator' }, deps);
    const secret = (added.data as { secret: string }).secret;
    const r = handleAuthList(deps);
    expect(r.success).toBe(true);
    const data = r.data as { enabled: boolean; tokens: Array<Record<string, unknown>> };
    expect(data.enabled).toBe(false);
    expect(data.tokens).toHaveLength(1);
    expect(data.tokens[0]).not.toHaveProperty('secretHash');
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe('auth/revoke', () => {
  it('按 id 删除；不存在 → 报错', async () => {
    const { config, deps } = makeDeps();
    const added = await handleAuthAdd({ name: 'A', role: 'readonly' }, deps);
    const id = (added.data as { id: string }).id;
    const r = await handleAuthRevoke({ id }, deps);
    expect(r.success).toBe(true);
    expect((config.auth as { tokens: unknown[] }).tokens).toHaveLength(0);
    expect((await handleAuthRevoke({ id }, deps)).success).toBe(false);
    expect((await handleAuthRevoke({}, deps)).success).toBe(false);
  });
});

describe('auth/enable + auth/disable', () => {
  it('零 token 时 enable 拒绝（防锁死）', async () => {
    const { config, deps } = makeDeps();
    const r = await handleAuthEnable(deps);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('token');
    expect(config.auth).toBeUndefined();
  });

  it('有 token → enable/disable 往返', async () => {
    const { config, deps } = makeDeps();
    await handleAuthAdd({ name: 'A', role: 'reviewer' }, deps);
    expect((await handleAuthEnable(deps)).success).toBe(true);
    expect((config.auth as { enabled: boolean }).enabled).toBe(true);
    expect((await handleAuthDisable(deps)).success).toBe(true);
    expect((config.auth as { enabled: boolean }).enabled).toBe(false);
  });

  it('存量 enabled 配置幂等', async () => {
    const { config, deps } = makeDeps({
      enabled: true,
      tokens: [{ id: 'tok_x', name: 'X', role: 'reviewer', secretHash: hashTokenSecret('zst_' + '9'.repeat(48)), createdAt: '2026-09-29T00:00:00.000Z' }],
    });
    expect((await handleAuthEnable(deps)).success).toBe(true);
    expect((config.auth as { enabled: boolean }).enabled).toBe(true);
  });
});
