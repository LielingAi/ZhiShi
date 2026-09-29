/**
 * token-store 单测（1.8.7 P1）：配置解析容错、secret 生成/哈希、查找——
 * 核心断言：**任何路径都不落盘明文 secret**（只存 SHA-256 哈希）。
 */
import { describe, expect, it } from 'vitest';

import {
  findTokenBySecret,
  generateTokenSecret,
  hashTokenSecret,
  normalizeAuthConfig,
  type AuthConfig,
} from './token-store';

function makeAuth(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { enabled: true, tokens: [], ...overrides };
}

describe('normalizeAuthConfig', () => {
  it('空/坏形状 → 关闭 + 空 tokens', () => {
    expect(normalizeAuthConfig(undefined)).toEqual({ enabled: false, tokens: [] });
    expect(normalizeAuthConfig(null)).toEqual({ enabled: false, tokens: [] });
    expect(normalizeAuthConfig({ enabled: 'yes', tokens: 'nope' })).toEqual({ enabled: false, tokens: [] });
  });

  it('合法条目保留（含 lastUsedAt），坏条目丢弃不炸', () => {
    const secret = 'zst_' + 'a'.repeat(48);
    const raw = {
      enabled: true,
      tokens: [
        { id: 'tok_1', name: 'A', role: 'reviewer', secretHash: hashTokenSecret(secret), createdAt: '2026-09-29T00:00:00.000Z', lastUsedAt: '2026-09-29T01:00:00.000Z' },
        { id: 'tok_bad', name: 'B', role: 'admin', secretHash: 'x', createdAt: '2026-01-01' }, // 非法 role/hash
        'garbage',
      ],
    };
    const auth = normalizeAuthConfig(raw);
    expect(auth.enabled).toBe(true);
    expect(auth.tokens).toHaveLength(1);
    expect(auth.tokens[0].role).toBe('reviewer');
    expect(auth.tokens[0].lastUsedAt).toBe('2026-09-29T01:00:00.000Z');
  });
});

describe('secret 生成与哈希', () => {
  it('generateTokenSecret：zst_ + 48 hex，两次生成不同', () => {
    const a = generateTokenSecret();
    const b = generateTokenSecret();
    expect(a).toMatch(/^zst_[a-f0-9]{48}$/);
    expect(a).not.toBe(b);
  });

  it('hashTokenSecret：SHA-256 hex，稳定且不等于明文', () => {
    const secret = 'zst_' + 'b'.repeat(48);
    const h = hashTokenSecret(secret);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toContain(secret);
    expect(hashTokenSecret(secret)).toBe(h);
    expect(hashTokenSecret(secret + 'x')).not.toBe(h);
  });
});

describe('findTokenBySecret', () => {
  it('命中/未命中/错误 secret 不命中', () => {
    const secret = generateTokenSecret();
    const other = generateTokenSecret();
    const auth = makeAuth({
      tokens: [
        { id: 'tok_1', name: 'A', role: 'readonly', secretHash: hashTokenSecret(secret), createdAt: '2026-09-29T00:00:00.000Z' },
        { id: 'tok_2', name: 'B', role: 'reviewer', secretHash: hashTokenSecret(other), createdAt: '2026-09-29T00:00:00.000Z' },
      ],
    });
    expect(findTokenBySecret(auth, secret)?.id).toBe('tok_1');
    expect(findTokenBySecret(auth, other)?.id).toBe('tok_2');
    expect(findTokenBySecret(auth, generateTokenSecret())).toBeUndefined();
    expect(findTokenBySecret(auth, '')).toBeUndefined();
  });

  it('存储形态断言：entry 上没有 secret 字段，secretHash 不含明文', () => {
    const secret = generateTokenSecret();
    const entry = { id: 'tok_1', name: 'A', role: 'operator' as const, secretHash: hashTokenSecret(secret), createdAt: '2026-09-29T00:00:00.000Z' };
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(secret);
    expect(entry).not.toHaveProperty('secret');
  });
});
