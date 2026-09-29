/**
 * config/get 脱敏单测（1.8.7 P1 R1 核查项——实测发现的问题与修复钉死）：
 *
 * 修复前：`config get providerApiKeys`（整 map）走 deepRedact——它只脱敏
 * 「键名匹配敏感模式」的字符串值，而 map 内层键是 provider id（deepseek
 * 等），不匹配 → **明文 API key 原样回传**。修复后 SENSITIVE_TOP_KEYS
 * （providerApiKeys / auth）整棵子树所有字符串叶子一律脱敏。
 *
 * 不受影响的面：config/set 语义（写路径不经过这里）；GUI 不消费 config/get
 * （全仓 grep 只有 CLI `zhishi config get` 走这条路由）。
 */
import { describe, expect, it } from 'vitest';

import { redactSensitiveValues } from './admin-api';

describe('redactSensitiveValues', () => {
  it('providerApiKeys 整 map：所有值脱敏，不回明文（R1 修复钉死）', () => {
    const out = redactSensitiveValues('providerApiKeys', {
      deepseek: 'sk-really-long-secret-key-1234567890',
      kimi: 'moonshot-another-secret-key-abcdef',
    }) as Record<string, string>;
    expect(out.deepseek).not.toBe('sk-really-long-secret-key-1234567890');
    expect(out.kimi).not.toBe('moonshot-another-secret-key-abcdef');
    expect(JSON.stringify(out)).not.toContain('really-long-secret');
    expect(JSON.stringify(out)).not.toContain('another-secret');
  });

  it('providerApiKeys.<id> 单 key 路径：脱敏', () => {
    const out = redactSensitiveValues('providerApiKeys.deepseek', 'sk-really-long-secret-key-1234567890');
    expect(out).not.toBe('sk-really-long-secret-key-1234567890');
    expect(String(out)).toContain('****');
  });

  it('auth 键整棵脱敏（secretHash/id/name 等字符串叶子一律不落明文）', () => {
    const out = redactSensitiveValues('auth', {
      enabled: true,
      tokens: [{ id: 'tok_abc123def456', name: '研究员A', role: 'reviewer', secretHash: 'f'.repeat(64), createdAt: '2026-09-29T00:00:00.000Z' }],
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain('f'.repeat(64));
    // 非字符串叶子（enabled 布尔）保留可读
    expect((out as { enabled: boolean }).enabled).toBe(true);
  });

  it('嵌套敏感字段（agents[].channels[].botToken 等）按模式脱敏', () => {
    const out = redactSensitiveValues('agents', [
      { id: 'a1', channels: [{ botToken: 'xoxb-1234567890-secret', feishuAppSecret: 'fs-secret-1234567' }] },
    ]);
    const s = JSON.stringify(out);
    expect(s).not.toContain('xoxb-1234567890-secret');
    expect(s).not.toContain('fs-secret-1234567');
  });

  it('普通配置项原样返回（不误伤）', () => {
    expect(redactSensitiveValues('defaultProviderId', 'kimi')).toBe('kimi');
    expect(redactSensitiveValues('autoRun', { budgetLimit: 30, mode: 'turns' })).toEqual({ budgetLimit: 30, mode: 'turns' });
  });
});
