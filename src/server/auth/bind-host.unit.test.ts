/**
 * bind-host 单测（1.8.7 P1）：--host/ZHISHI_HOST/默认 的优先级 + 回环判定。
 */
import { describe, expect, it } from 'vitest';

import { isLoopbackHost, resolveBindHost } from './bind-host';

describe('resolveBindHost 优先级', () => {
  it('都未设 → 127.0.0.1（默认一字节不变）', () => {
    expect(resolveBindHost(null, undefined)).toBe('127.0.0.1');
    expect(resolveBindHost(undefined, undefined)).toBe('127.0.0.1');
  });

  it('旗标优先于环境变量', () => {
    expect(resolveBindHost('0.0.0.0', '10.0.0.8')).toBe('0.0.0.0');
  });

  it('仅环境变量 → 环境变量生效', () => {
    expect(resolveBindHost(null, '10.0.0.8')).toBe('10.0.0.8');
  });

  it('空串按未设处理（含空白）', () => {
    expect(resolveBindHost('', '10.0.0.8')).toBe('10.0.0.8');
    expect(resolveBindHost('   ', undefined)).toBe('127.0.0.1');
    expect(resolveBindHost(null, '  ')).toBe('127.0.0.1');
  });

  it('取值去首尾空白', () => {
    expect(resolveBindHost('  0.0.0.0 ', undefined)).toBe('0.0.0.0');
  });
});

describe('isLoopbackHost', () => {
  it('回环形态', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', '127.255.0.1', 'localhost', 'dev.localhost', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('非回环形态', () => {
    for (const h of ['0.0.0.0', '10.0.0.8', '192.168.1.10', '::', 'example.com', '128.0.0.1', '']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});
