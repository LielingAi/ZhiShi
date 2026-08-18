/**
 * entry unit tests — ensureAgentSession switch fallback (stale session
 * metadata must not abort the TUI launch).
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

describe('ensureAgentSession', () => {
  it('falls through stale (unswitchable) sessions to the next candidate', async () => {
    const switches: string[] = [];
    const client = clientWith((url, body) => {
      if (url.includes('/sessions?')) {
        return {
          success: true,
          sessions: [
            { id: 'stale', updatedAt: '2026-08-16T10:00:00Z' },
            { id: 'good', updatedAt: '2026-08-16T09:00:00Z' },
          ],
        };
      }
      if (url.includes('/sessions/switch')) {
        const id = String(body.sessionId);
        switches.push(id);
        return id === 'stale' ? { success: false, error: 'Session not found.' } : { success: true };
      }
      return { success: true };
    });
    expect(await ensureAgentSession(client, '/ws')).toBe('good');
    expect(switches).toEqual(['stale', 'good']); // newest first, then fallback
  });

  it('creates a fresh security session when nothing is switchable', async () => {
    let createBody: Record<string, unknown> | null = null;
    const client = clientWith((url, body) => {
      if (url.includes('/sessions?')) {
        return { success: true, sessions: [{ id: 'stale', updatedAt: '2026-01-01' }] };
      }
      if (url.includes('/sessions/switch')) {
        return { success: false, error: 'Session not found.' };
      }
      createBody = body;
      return { success: true, session: { id: 'fresh' } };
    });
    expect(await ensureAgentSession(client, '/ws')).toBe('fresh');
    expect(createBody).not.toBeNull();
    expect((createBody as unknown as Record<string, unknown>).scenario).toBe('security');
  });
});
