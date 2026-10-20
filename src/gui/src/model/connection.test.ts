/**
 * 连接模式单测（注入 storage，不碰真 localStorage）。
 * normalizeServerUrl 用例与 src/cli/remote.unit.test.ts 同口径（两边语义
 * 必须一致——CLI/GUI 连的是同一个团队大脑）。
 *
 * 2.0.3 增补：pollRemoteRelayPort（远端中继端口轮询）——契约对齐
 * commands.rs::get_sidecar_port：幂等 ensure、null = 未就绪、IPC 瞬断
 * 吞错重试、超时兜底返回 null。时钟/睡眠全部注入，零真实等待。
 */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_DEFAULTS,
  CONNECTION_STORAGE_KEY,
  loadConnection,
  normalizeServerUrl,
  pollRemoteRelayPort,
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

function makeClock(start = 10_000) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe('pollRemoteRelayPort', () => {
  it('立即就绪：一次调用返回端口', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const port = await pollRemoteRelayPort(
      async (cmd, args) => {
        calls.push([cmd, args]);
        return 41_234;
      },
      'http://10.0.0.8:7411',
      makeClock(),
    );
    expect(port).toBe(41_234);
    expect(calls).toEqual([['get_sidecar_port', { remoteUrl: 'http://10.0.0.8:7411' }]]);
  });

  it('未就绪轮询：null 若干次后拿到端口', async () => {
    let n = 0;
    const clock = makeClock();
    const port = await pollRemoteRelayPort(
      async () => {
        n++;
        return n < 3 ? null : 37_411;
      },
      'http://10.0.0.8:7411',
      { ...clock, intervalMs: 500, timeoutMs: 20_000 },
    );
    expect(port).toBe(37_411);
    expect(n).toBe(3);
  });

  it('超时返回 null，调用次数符合 interval/timeout', async () => {
    let n = 0;
    const clock = makeClock();
    const port = await pollRemoteRelayPort(
      async () => {
        n++;
        return null;
      },
      'http://10.0.0.8:7411',
      { ...clock, intervalMs: 500, timeoutMs: 2_000 },
    );
    expect(port).toBeNull();
    // t=10k 起：10k/15k/20k/25k/30k 各查一次（30k ≥ deadline 停）。
    expect(n).toBe(5);
  });

  it('IPC 瞬断（抛错）吞掉继续轮询', async () => {
    let n = 0;
    const port = await pollRemoteRelayPort(
      async () => {
        n++;
        if (n < 3) throw new Error('IPC 窗口关闭竞态');
        return 41_234;
      },
      'http://10.0.0.8:7411',
      makeClock(),
    );
    expect(port).toBe(41_234);
    expect(n).toBe(3);
  });

  it('非法返回值（0 / 超界 / 非数字）忽略继续轮询', async () => {
    const values: unknown[] = [0, 70_000, '4133', -1, null, 41_234];
    let n = 0;
    const port = await pollRemoteRelayPort(
      async () => values[n++] ?? null,
      'http://10.0.0.8:7411',
      makeClock(),
    );
    expect(port).toBe(41_234);
    expect(n).toBe(6);
  });
});
