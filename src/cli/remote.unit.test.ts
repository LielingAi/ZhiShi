/**
 * remote（CLI 远端模式，1.8.7 P0.5）单元测试。
 *
 * 纯函数无 IO 直接断言：normalizeServerUrl（scheme 补全/尾部斜杠/非法值）、
 * resolveRemoteServer / resolveRemoteToken（--旗标 > 环境变量优先级）、
 * probeRemoteHealth（fetch 注入：活/死/token 头透传）——不碰真实网络。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  normalizeServerUrl,
  probeRemoteHealth,
  resolveRemoteServer,
  resolveRemoteToken,
  type RemoteHealthFetch,
} from './remote';

let prevServer: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  prevServer = process.env.ZHISHI_SERVER;
  prevToken = process.env.ZHISHI_TOKEN;
  delete process.env.ZHISHI_SERVER;
  delete process.env.ZHISHI_TOKEN;
});

afterEach(() => {
  if (prevServer === undefined) delete process.env.ZHISHI_SERVER;
  else process.env.ZHISHI_SERVER = prevServer;
  if (prevToken === undefined) delete process.env.ZHISHI_TOKEN;
  else process.env.ZHISHI_TOKEN = prevToken;
});

describe('normalizeServerUrl', () => {
  it('完整 URL 原样（剥尾部斜杠）', () => {
    expect(normalizeServerUrl('http://10.0.0.8:7411')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('http://10.0.0.8:7411/')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('http://10.0.0.8:7411///')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('https://brain.internal:443/')).toBe('https://brain.internal:443');
  });

  it('缺 scheme 的 host:port 补 http://', () => {
    expect(normalizeServerUrl('10.0.0.8:7411')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('brain.internal:7411/')).toBe('http://brain.internal:7411');
  });

  it('非法 URL 抛错（调用方翻 exit 2）', () => {
    expect(() => normalizeServerUrl('')).toThrow();
    expect(() => normalizeServerUrl('http://')).toThrow();
  });
});

describe('resolveRemoteServer（--server > ZHISHI_SERVER > 本机链）', () => {
  it('都未设 → undefined（本机模式）', () => {
    expect(resolveRemoteServer({})).toBeUndefined();
  });

  it('仅 ZHISHI_SERVER → 用环境变量', () => {
    process.env.ZHISHI_SERVER = '10.0.0.8:7411';
    expect(resolveRemoteServer({})).toBe('http://10.0.0.8:7411');
  });

  it('--server 覆盖 ZHISHI_SERVER', () => {
    process.env.ZHISHI_SERVER = 'http://env-host:1';
    expect(resolveRemoteServer({ server: 'http://flag-host:2/' })).toBe('http://flag-host:2');
  });

  it('非法值抛错', () => {
    process.env.ZHISHI_SERVER = 'http://';
    expect(() => resolveRemoteServer({})).toThrow();
  });
});

describe('resolveRemoteToken（--token > ZHISHI_TOKEN）', () => {
  it('都未设 → undefined', () => {
    expect(resolveRemoteToken({})).toBeUndefined();
  });

  it('仅 ZHISHI_TOKEN → 用环境变量', () => {
    process.env.ZHISHI_TOKEN = 'env-token';
    expect(resolveRemoteToken({})).toBe('env-token');
  });

  it('--token 覆盖 ZHISHI_TOKEN', () => {
    process.env.ZHISHI_TOKEN = 'env-token';
    expect(resolveRemoteToken({ token: 'flag-token' })).toBe('flag-token');
  });
});

describe('probeRemoteHealth（fetch 注入）', () => {
  it('2xx → ok，URL = <server>/health', async () => {
    let seenUrl = '';
    const fetchImpl: RemoteHealthFetch = async (url) => { seenUrl = url; return { ok: true }; };
    const r = await probeRemoteHealth('http://10.0.0.8:7411', undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe('http://10.0.0.8:7411/health');
  });

  it('带 token → Authorization: Bearer 头随探测发出', async () => {
    let seenAuth: string | undefined;
    const fetchImpl: RemoteHealthFetch = async (_url, init) => {
      seenAuth = init?.headers?.Authorization;
      return { ok: true };
    };
    await probeRemoteHealth('http://h:1', 'secret-token', fetchImpl);
    expect(seenAuth).toBe('Bearer secret-token');
  });

  it('无 token → 不带 Authorization 头', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl: RemoteHealthFetch = async (_url, init) => {
      seenHeaders = init?.headers;
      return { ok: true };
    };
    await probeRemoteHealth('http://h:1', undefined, fetchImpl);
    expect(seenHeaders).toBeUndefined();
  });

  it('传输层失败 → ok:false + 错误信息', async () => {
    const fetchImpl: RemoteHealthFetch = async () => { throw new Error('fetch failed'); };
    const r = await probeRemoteHealth('http://dead:1', undefined, fetchImpl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('fetch failed');
  });

  it('非 2xx → ok:false', async () => {
    const fetchImpl: RemoteHealthFetch = async () => ({ ok: false });
    const r = await probeRemoteHealth('http://h:1', undefined, fetchImpl);
    expect(r.ok).toBe(false);
  });
});
