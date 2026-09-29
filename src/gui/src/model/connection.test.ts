/**
 * 连接模式单测（注入 storage，不碰真 localStorage）。
 * normalizeServerUrl 用例与 src/cli/remote.unit.test.ts 同口径（两边语义
 * 必须一致——CLI/GUI 连的是同一个团队大脑）。
 */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_DEFAULTS,
  CONNECTION_STORAGE_KEY,
  loadConnection,
  normalizeServerUrl,
  saveConnection,
  type ConnectionSettings,
} from './connection';

describe('normalizeServerUrl', () => {
  it('合法 URL 原样返回（剥尾部斜杠）', () => {
    expect(normalizeServerUrl('http://10.0.0.8:7411')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('http://10.0.0.8:7411/')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('http://10.0.0.8:7411///')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('https://brain.internal:443/')).toBe('https://brain.internal:443');
  });

  it('缺 scheme 补 http://', () => {
    expect(normalizeServerUrl('10.0.0.8:7411')).toBe('http://10.0.0.8:7411');
    expect(normalizeServerUrl('brain.internal:7411/')).toBe('http://brain.internal:7411');
  });

  it('前后空白容忍；非法值抛错', () => {
    expect(normalizeServerUrl('  10.0.0.8:7411  ')).toBe('http://10.0.0.8:7411');
    expect(() => normalizeServerUrl('')).toThrow();
    expect(() => normalizeServerUrl('   ')).toThrow();
    expect(() => normalizeServerUrl('http://')).toThrow();
  });
});

describe('loadConnection', () => {
  it('缺失/损坏/非法 mode → 本机默认', () => {
    expect(loadConnection(undefined)).toEqual(CONNECTION_DEFAULTS);
    expect(loadConnection({ getItem: () => null })).toEqual(CONNECTION_DEFAULTS);
    expect(loadConnection({ getItem: () => 'not-json' })).toEqual(CONNECTION_DEFAULTS);
    expect(loadConnection({ getItem: () => '{"mode":"alien"}' })).toEqual(CONNECTION_DEFAULTS);
    expect(loadConnection({ getItem: () => '42' })).toEqual(CONNECTION_DEFAULTS);
  });

  it('读 remote 配置（字段缺失容忍为空串）', () => {
    const s = loadConnection({
      getItem: () => JSON.stringify({ mode: 'remote', serverUrl: 'http://10.0.0.8:7411', token: 't' }),
    });
    expect(s).toEqual({ mode: 'remote', serverUrl: 'http://10.0.0.8:7411', token: 't' });

    const partial = loadConnection({ getItem: () => '{"mode":"remote"}' });
    expect(partial).toEqual({ mode: 'remote', serverUrl: '', token: '' });
  });

  it('storage 抛错静默回落默认', () => {
    expect(
      loadConnection({
        getItem: () => {
          throw new Error('denied');
        },
      }),
    ).toEqual(CONNECTION_DEFAULTS);
  });
});

describe('saveConnection / loadConnection 往返', () => {
  it('写后读回同值；键名固定', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    const settings: ConnectionSettings = { mode: 'remote', serverUrl: 'brain:7411', token: 'secret' };
    saveConnection(storage, settings);
    expect(map.has(CONNECTION_STORAGE_KEY)).toBe(true);
    expect(loadConnection(storage)).toEqual(settings);
  });

  it('setItem 抛错静默（不传播）', () => {
    expect(() =>
      saveConnection(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('denied');
          },
        },
        CONNECTION_DEFAULTS,
      ),
    ).not.toThrow();
  });
});
