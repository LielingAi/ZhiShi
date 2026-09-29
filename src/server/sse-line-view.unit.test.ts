/**
 * 1.8.7 P3a 按线寻址：createSseClient({ live:false }) 只读历史视图
 * （/chat/stream?sessionId=<非当前线>）——不进全局扇出集合（broadcast
 * 永不送达；P3a 全部 live 事件都属于当前线，送达即串线），跳过 log 历史
 * 与 last-value cache 重放；直接 client.send（盘上历史重放）照常写出。
 * live 缺省 true 的今日语义不变。
 */

import { describe, expect, it } from 'vitest';

import { broadcast, createSseClient, getClients } from './sse';

async function readFirstChunk(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  try {
    const { value } = await reader.read();
    return new TextDecoder().decode(value);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe('createSseClient live:false（P3a 只读历史视图）', () => {
  it('不进 clients 集合；broadcast 不送达；直接 send（历史重放）照常写出', async () => {
    const liveClient = createSseClient(() => {});
    const history = createSseClient(() => {}, { live: false });
    try {
      const liveIds = getClients().map((c) => c.id);
      expect(liveIds).toContain(liveClient.client.id);
      expect(liveIds).not.toContain(history.client.id);
      // broadcast 只进 live 扇出
      broadcast('chat:status', { sessionState: 'idle', sessionId: 'ls-x' });
      const liveChunk = await readFirstChunk(liveClient.response);
      expect(liveChunk).toContain('chat:status');
      // 历史视图：直接 send（/chat/stream 历史分支的盘上重放）照常写出
      history.client.send('chat:message-replay', {
        message: { id: '0', role: 'user', content: '旧问题', timestamp: '' },
        replayKind: 'cold-history',
        sessionId: 'ls-old',
      });
      const historyChunk = await readFirstChunk(history.response);
      expect(historyChunk).toContain('chat:message-replay');
      expect(historyChunk).toContain('ls-old');
    } finally {
      liveClient.client.close();
      history.client.close();
    }
  });

  it('live 缺省（不传 opts）= 今日语义：进 clients 集合，收 broadcast', async () => {
    const c = createSseClient(() => {});
    try {
      expect(getClients().map((x) => x.id)).toContain(c.client.id);
      broadcast('chat:status', { sessionState: 'idle', sessionId: 'ls-y' });
      const chunk = await readFirstChunk(c.response);
      expect(chunk).toContain('chat:status');
    } finally {
      c.client.close();
    }
  });
});
