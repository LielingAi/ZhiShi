// Unit tests for the sidecar root-path client (P1-T2).
// fetch is injected, so REST envelopes and SSE reconnect/abort behavior are
// exercised without a real server.
import { describe, expect, it, vi } from 'vitest';

import {
  SidecarClient,
  SidecarConnectionError,
  SidecarHttpError,
  type FetchLike,
  type FetchResponseLike,
  type SseStreamBody,
} from './client';

// ---------------------------------------------------------------------------
// Fetch fakes
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    body: null,
  };
}

function textResponse(text: string, status: number): FetchResponseLike {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: { get: () => 'text/plain' },
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(text),
    body: null,
  };
}

/** SSE response replaying `frames`; ends the stream unless `hang` (stays open). */
function sseResponse(frames: string[], opts: { hang?: boolean } = {}): FetchResponseLike {
  const encoder = new TextEncoder();
  const chunks = frames.map((f) => encoder.encode(f));
  let i = 0;
  const body: SseStreamBody = {
    getReader: () => ({
      read: () => {
        if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
        if (opts.hang) return new Promise(() => {}); // open stream: resolves only via abort race
        return Promise.resolve({ done: true, value: undefined });
      },
      cancel: () => Promise.resolve(),
    }),
  };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'text/event-stream' },
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(frames.join('')),
    body,
  };
}

const BASE = 'http://127.0.0.1:19100';

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

describe('postJson / getJson', () => {
  it('posts JSON to base+path and returns the parsed envelope', async () => {
    const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse({ success: true, queueId: 'q9' }));
    };
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const res = await client.postJson<{ success: boolean; queueId: string }>('/chat/send', { text: 'hi' });
    expect(res.queueId).toBe('q9');
    expect(calls[0].url).toBe(`${BASE}/chat/send`);
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('{"text":"hi"}');
  });

  it('returns the parsed error envelope for non-2xx JSON (caller checks success)', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(jsonResponse({ success: false, error: 'bad' }, 400));
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const res = await client.postJson<{ success: boolean; error: string }>('/x', {});
    expect(res.success).toBe(false);
  });

  it('throws SidecarHttpError for non-JSON error bodies', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(textResponse('missing field `doc`', 422));
    const client = new SidecarClient({ base: BASE, fetchImpl });
    await expect(client.postJson('/x', {})).rejects.toThrow(SidecarHttpError);
    await expect(client.postJson('/x', {})).rejects.toThrow(/422.*missing field/s);
  });

  it('maps transport failures to SidecarConnectionError naming the base URL', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const client = new SidecarClient({ base: BASE, fetchImpl });
    await expect(client.getJson('/sessions?agentDir=%2Fx')).rejects.toThrow(SidecarConnectionError);
    await expect(client.getJson('/sessions')).rejects.toThrow(new RegExp(BASE.replace(/[.:/]/g, '\\$&')));
  });

  it('getJson issues a GET against the full path (query included)', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return Promise.resolve(jsonResponse({ success: true, sessions: [] }));
    };
    const client = new SidecarClient({ base: BASE, fetchImpl });
    await client.getJson('/sessions?agentDir=E%3A%5Ccode');
    expect(calls).toEqual([`GET ${BASE}/sessions?agentDir=E%3A%5Ccode`]);
  });

  it('adminPost targets /api/admin/<route> with the given body (P1-T4)', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, body: init?.body });
      return Promise.resolve(jsonResponse({ success: true, data: { selection: { kind: 'host' } } }));
    };
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const res = await client.adminPost<{ success: boolean }>('environment/select', {
      workspace: 'E:/work',
      selection: { kind: 'host' },
    });
    expect(res.success).toBe(true);
    expect(calls[0].url).toBe(`${BASE}/api/admin/environment/select`);
    expect(calls[0].body).toBe('{"workspace":"E:/work","selection":{"kind":"host"}}');
  });
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

describe('openSse', () => {
  it('parses event/data frames (multi-line data joined, comments skipped)', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        sseResponse(
          [
            'event: chat:status\ndata: {"sessionState":"idle"}\n\n',
            ': ping\n\nevent: chat:message-chunk\ndata: hel\ndata: lo\n\n',
          ],
          { hang: true },
        ),
      );
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const ac = new AbortController();
    const it = client.openSse('/chat/stream', { signal: ac.signal });
    expect(await it.next()).toEqual({ done: false, value: { event: 'chat:status', data: '{"sessionState":"idle"}' } });
    expect(await it.next()).toEqual({ done: false, value: { event: 'chat:message-chunk', data: 'hel\nlo' } });
    ac.abort();
    expect((await it.next()).done).toBe(true);
  });

  it('reconnects after a clean EOF and keeps yielding (server replays on reconnect)', async () => {
    const onReconnect = vi.fn();
    let call = 0;
    const fetchImpl: FetchLike = () => {
      call++;
      return Promise.resolve(
        call === 1
          ? sseResponse(['event: chat:init\ndata: {"sessionState":"idle"}\n\n']) // ends → EOF
          : sseResponse(['event: chat:init\ndata: {"sessionState":"idle"}\n\n'], { hang: true }),
      );
    };
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const ac = new AbortController();
    const it = client.openSse('/chat/stream', { signal: ac.signal, retryDelayMs: 1, onReconnect });
    const first = await it.next();
    const second = await it.next(); // crosses the reconnect boundary
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(call).toBe(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect.mock.calls[0][0]).toBe(1);
    ac.abort();
    expect((await it.next()).done).toBe(true);
  });

  it('retries after a transport failure, then delivers events', async () => {
    const onReconnect = vi.fn();
    let call = 0;
    const fetchImpl: FetchLike = () => {
      call++;
      if (call === 1) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(sseResponse(['event: chat:status\ndata: {"sessionState":"running"}\n\n'], { hang: true }));
    };
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const ac = new AbortController();
    const it = client.openSse('/chat/stream', { signal: ac.signal, retryDelayMs: 1, onReconnect });
    const ev = await it.next();
    expect(ev).toEqual({ done: false, value: { event: 'chat:status', data: '{"sessionState":"running"}' } });
    expect(call).toBe(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    ac.abort();
    await it.next();
  });

  it('retries a non-2xx SSE open instead of throwing', async () => {
    let call = 0;
    const fetchImpl: FetchLike = () => {
      call++;
      if (call === 1) return Promise.resolve(textResponse('nope', 500));
      return Promise.resolve(sseResponse(['event: chat:status\ndata: {"sessionState":"idle"}\n\n'], { hang: true }));
    };
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const ac = new AbortController();
    const it = client.openSse('/chat/stream', { signal: ac.signal, retryDelayMs: 1 });
    expect((await it.next()).done).toBe(false);
    expect(call).toBe(2);
    ac.abort();
    await it.next();
  });

  it('stops promptly when aborted mid-stream without waiting for the next frame', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(sseResponse([], { hang: true }));
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const ac = new AbortController();
    const it = client.openSse('/chat/stream', { signal: ac.signal, retryDelayMs: 1 });
    const pending = it.next();
    ac.abort();
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung after abort')), 2000)),
    ]);
    expect((result as IteratorResult<unknown>).done).toBe(true);
  });

  it('does not reconnect once aborted', async () => {
    let call = 0;
    const fetchImpl: FetchLike = () => {
      call++;
      return Promise.resolve(sseResponse([]));
    };
    const client = new SidecarClient({ base: BASE, fetchImpl });
    const ac = new AbortController();
    ac.abort();
    const it = client.openSse('/chat/stream', { signal: ac.signal, retryDelayMs: 1 });
    expect((await it.next()).done).toBe(true);
    expect(call).toBe(0);
  });
});
