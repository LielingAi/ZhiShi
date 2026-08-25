/**
 * 端口发现单测（注入 invoke / storage / sleep，不碰真 Tauri）。
 */

import { describe, expect, it } from 'vitest';

import { parsePortParam, pollTauriPort, readStoredPort, resolvePort } from './port';

describe('parsePortParam', () => {
  it('解析 ?port=3199', () => {
    expect(parsePortParam('?port=3199')).toBe(3199);
    expect(parsePortParam('?a=1&port=8080')).toBe(8080);
  });
  it('非法值返回 null', () => {
    expect(parsePortParam('')).toBeNull();
    expect(parsePortParam('?port=abc')).toBeNull();
    expect(parsePortParam('?port=99999')).toBeNull();
    expect(parsePortParam('?port=-1')).toBeNull();
  });
});

describe('readStoredPort', () => {
  it('读 localStorage.zhishiPort', () => {
    expect(readStoredPort({ getItem: () => '3199' })).toBe(3199);
    expect(readStoredPort({ getItem: () => 'garbage' })).toBeNull();
    expect(readStoredPort({ getItem: () => null })).toBeNull();
  });
});

describe('pollTauriPort', () => {
  it('轮询直到拿到端口', async () => {
    let calls = 0;
    const port = await pollTauriPort(
      async () => {
        calls++;
        return calls >= 3 ? 4321 : null;
      },
      { intervalMs: 1, timeoutMs: 1000 },
    );
    expect(port).toBe(4321);
    expect(calls).toBe(3);
  });

  it('超时返回 null', async () => {
    const port = await pollTauriPort(async () => null, { intervalMs: 1, timeoutMs: 10 });
    expect(port).toBeNull();
  });

  it('IPC 抛错时继续重试（不中断轮询）', async () => {
    let calls = 0;
    const port = await pollTauriPort(
      async () => {
        calls++;
        if (calls === 1) throw new Error('ipc gone');
        return 5555;
      },
      { intervalMs: 1, timeoutMs: 1000 },
    );
    expect(port).toBe(5555);
  });
});

describe('resolvePort', () => {
  it('?port= 优先于 Tauri 与 localStorage', async () => {
    const invoke = async () => 1;
    const port = await resolvePort({ search: '?port=3000', invoke, storage: { getItem: () => '4000' } });
    expect(port).toBe(3000);
  });

  it('Tauri 轮询可用时用之', async () => {
    const port = await resolvePort({ invoke: async () => 7777, search: '' });
    expect(port).toBe(7777);
  });

  it('浏览器 dev 回退 localStorage', async () => {
    const port = await resolvePort({ search: '', storage: { getItem: () => '8081' } });
    expect(port).toBe(8081);
  });

  it('全无 → null', async () => {
    const port = await resolvePort({ search: '' });
    expect(port).toBeNull();
  });
});
