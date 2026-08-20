/**
 * entry unit tests — ensureAgentSession env-aware attach (1.1.6 #4):
 * 按当前选定环境的分线绑定接线；映射失效/无映射 → 建 security 新会话。
 * 旧「全 workspace 最新逐个试 switch」语义已废除（跨环境串线）。
 */

import { describe, it, expect } from 'vitest';
import { SidecarClient, type FetchLike, type FetchResponseLike } from '../client';
import { ensureAgentSession } from './entry';

type Handler = (url: string, body: Record<string, unknown>) => Record<string, unknown>;

function clientWith(handler: Handler): SidecarClient {
  const fetchImpl: FetchLike = (async (url: string, init?: { body?: string }) => {
    const payload = handler(url, JSON.parse(init?.body ?? '{}'));
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      body: null,
    } as FetchResponseLike;
  }) as FetchLike;
  return new SidecarClient({ base: 'http://test', fetchImpl });
}

describe('ensureAgentSession（1.1.6 #4 环境分线接线）', () => {
  it('当前环境有分线绑定 → 直接 switch 到该会话（不再遍历全 workspace 会话）', async () => {
    const calls: string[] = [];
    const client = clientWith((url, body) => {
      calls.push(url);
      if (url.includes('environment/current')) {
        expect(body.workspace).toBe('/ws');
        return { success: true, data: { sessionId: 'mapped-session' } };
      }
      if (url.includes('/sessions/switch')) {
        expect(body.sessionId).toBe('mapped-session');
        return { success: true };
      }
      return { success: true };
    });
    expect(await ensureAgentSession(client, '/ws')).toBe('mapped-session');
    // 旧语义的 GET /sessions 列表遍历不再发生
    expect(calls.some((u) => u.includes('/sessions?'))).toBe(false);
  });

  it('分线绑定失效（switch 404）→ 回落建 security 新会话', async () => {
    let createBody: Record<string, unknown> | null = null;
    const client = clientWith((url, body) => {
      if (url.includes('environment/current')) {
        return { success: true, data: { sessionId: 'stale-session' } };
      }
      if (url.includes('/sessions/switch')) {
        return { success: false, error: 'Session not found.' };
      }
      createBody = body;
      return { success: true, session: { id: 'fresh' } };
    });
    expect(await ensureAgentSession(client, '/ws')).toBe('fresh');
    expect((createBody as unknown as Record<string, unknown>).scenario).toBe('security');
  });

  it('无分线映射（sessionId null）→ 直接建 security 新会话，不试 switch', async () => {
    let switched = false;
    const client = clientWith((url, body) => {
      if (url.includes('environment/current')) {
        return { success: true, data: { sessionId: null } };
      }
      if (url.includes('/sessions/switch')) {
        switched = true;
        return { success: true };
      }
      expect(body.agentDir).toBe('/ws');
      return { success: true, session: { id: 'fresh' } };
    });
    expect(await ensureAgentSession(client, '/ws')).toBe('fresh');
    expect(switched).toBe(false);
  });

  it('environment/current 失败 → 抛错（入口打印后不进门）', async () => {
    const client = clientWith((url) => {
      if (url.includes('environment/current')) {
        return { success: false, error: 'sidecar boom' };
      }
      return { success: true };
    });
    await expect(ensureAgentSession(client, '/ws')).rejects.toThrow('sidecar boom');
  });
});
