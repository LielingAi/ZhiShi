/**
 * 1.2.0 — 敏感项扫描/脱敏（report/sensitive.ts）unit tests。
 * 计数(批准模态的知情清单)、汇总格式、逐命中遮蔽、无误伤。
 */
import { describe, expect, it } from 'vitest';

import { formatSensitiveSummary, sanitizeSensitiveText, scanSensitiveHits } from './sensitive';

describe('scanSensitiveHits', () => {
  it('flag/密钥/内网 IP/API key/私钥 分类计数', () => {
    const text = [
      '拿到 flag{sql_master_2026} 一枚',
      '配置文件 api_key = "abcdef1234567890abcdef1234567890"',
      '跳板 192.168.1.10 与 10.0.0.8,还有 172.16.3.4',
      ' sk-abcdefghijklmnop1234 ',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const hits = scanSensitiveHits(text);
    const byCat = new Map(hits.map((h) => [h.category, h.count]));
    expect(byCat.get('flag')).toBe(1);
    expect(byCat.get('密钥')).toBe(1);
    expect(byCat.get('内网 IP')).toBe(3);
    expect(byCat.get('API key')).toBe(1);
    expect(byCat.get('私钥')).toBe(1);
  });

  it('多个同类命中累加;公网 IP/普通文本不误伤', () => {
    expect(scanSensitiveHits('flag{a} 再 flag{b}').find((h) => h.category === 'flag')?.count).toBe(2);
    expect(scanSensitiveHits('8.8.8.8 与 172.32.0.1(非内网) 普通文本 nothing')).toEqual([]);
    expect(scanSensitiveHits('')).toEqual([]);
  });

  it('同一段文本连续扫描结果稳定(模式无跨调用状态泄漏)', () => {
    const text = 'flag{x} 10.1.1.1';
    expect(scanSensitiveHits(text)).toEqual(scanSensitiveHits(text));
  });
});

describe('formatSensitiveSummary', () => {
  it('「flag×1 密钥×2 内网 IP×3」形态;无命中 → 无', () => {
    expect(formatSensitiveSummary([
      { category: 'flag', count: 1 },
      { category: '密钥', count: 2 },
      { category: '内网 IP', count: 3 },
    ])).toBe('flag×1 密钥×2 内网 IP×3');
    expect(formatSensitiveSummary([])).toBe('无');
  });
});

describe('sanitizeSensitiveText', () => {
  it('逐命中遮蔽为 [redacted:类别],计数基于遮蔽前原文', () => {
    const { text, hits } = sanitizeSensitiveText('flag{abc} 走 10.0.0.1 拿到 token: "abcdefghijklmnopqrst"');
    expect(text).toContain('[redacted:flag]');
    expect(text).toContain('[redacted:内网 IP]');
    expect(text).toContain('[redacted:密钥]');
    expect(text).not.toContain('flag{abc}');
    expect(text).not.toContain('10.0.0.1');
    expect(hits.length).toBe(3);
  });

  it('无命中原文原样返回', () => {
    const { text, hits } = sanitizeSensitiveText('干净文本 clean text 8.8.8.8');
    expect(text).toBe('干净文本 clean text 8.8.8.8');
    expect(hits).toEqual([]);
  });
});
