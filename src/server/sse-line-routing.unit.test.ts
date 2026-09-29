/**
 * 1.8.7 P3b SSE 按线分流（双线制 + 多引擎）。
 *
 * 覆盖：
 *  - 带线订阅者只收「全局 + 本线」：线 A 订阅者收不到线 B 的事件——含
 *    形状钉死的 chat:message-chunk / chat:message-error / chat:message-stopped
 *    （string|null payload 逐字节不动,分流走 broadcast 第三参的路由元
 *    数据通道）;
 *  - 路由键回退:无 {line} 时取 object payload 的 additive sessionId(P3a);
 *  - 探针语义:无 live 引擎的线(headless/已回收)= 全局 fan-out(1.8.6
 *    语义——没人订阅 headless 线,它们的事件今天全员可达);未挂探针 =
 *    一切全局(旧 fan-out 逐字节);
 *  - last-value cache(chat:status)按线各存一份,重放按订阅线过滤;
 *  - chunk 合并窗按线隔离(两条线的 token 流不串)。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { broadcast, createSseClient, getClients, __setLineLiveProbe } from './sse';

/** 每响应一个后台泵,把到达的帧累积成文本;waitFor 轮询断言(超时返回
 *  当前累积——「收不到」类断言按全窗口等待后的缺席判定)。 */
function makeCollector(response: Response): { waitFor: (matcher: (all: string) => boolean, ms?: number) => Promise<string> } {
  const chunks: string[] = [];
  const reader = response.body!.getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
  })();
  return {
    async waitFor(matcher, ms = 1000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const all = chunks.join('');
        if (matcher(all) || Date.now() > deadline) return all;
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

afterEach(() => {
  __setLineLiveProbe(null);
  for (const c of getClients()) c.close();
});

describe('P3b SSE 按线分流', () => {
  it('线 A 订阅者收不到线 B 的事件(object payload 经 additive sessionId 路由)', async () => {
    __setLineLiveProbe((line) => line === 'ls-a' || line === 'ls-b');
    const a = createSseClient(() => {}, { line: 'ls-a' });
    const b = createSseClient(() => {}, { line: 'ls-b' });
    const ca = makeCollector(a.response);
    const cb = makeCollector(b.response);
    try {
      broadcast('chat:status', { sessionState: 'running', sessionId: 'ls-b' }, { line: 'ls-b' });
      expect(await cb.waitFor((s) => s.includes('chat:status'))).toContain('ls-b');
      // 线 A 订阅者收不到线 B 的状态(全窗口等待后缺席)
      expect(await ca.waitFor((s) => s.includes('ls-b'), 300)).not.toContain('ls-b');
    } finally {
      a.client.close();
      b.client.close();
    }
  });

  it('形状钉死事件(string|null payload)经路由元数据通道分流,payload 逐字节不动', async () => {
    __setLineLiveProbe(() => true);
    const a = createSseClient(() => {}, { line: 'ls-a' });
    const b = createSseClient(() => {}, { line: 'ls-b' });
    const ca = makeCollector(a.response);
    const cb = makeCollector(b.response);
    try {
      // chat:message-error:string payload 形状钉死——线上原样,不带信封
      broadcast('chat:message-error', 'B 线错误原文', { line: 'ls-b' });
      const bErr = await cb.waitFor((s) => s.includes('chat:message-error'));
      expect(bErr).toContain('data: B 线错误原文'); // 裸 string,无包装
      expect(bErr).not.toContain('sessionId');
      expect(await ca.waitFor((s) => s.includes('B 线错误原文'), 300)).not.toContain('B 线错误原文');

      // chat:message-stopped:null payload 同理
      broadcast('chat:message-stopped', null, { line: 'ls-b' });
      expect(await cb.waitFor((s) => s.includes('message-stopped'))).toContain('data: null');
      expect(await ca.waitFor((s) => s.includes('message-stopped'), 300)).not.toContain('message-stopped');

      // chat:message-chunk:合并窗按线隔离——两线各发 delta,互不串字
      broadcast('chat:message-chunk', 'AAA', { line: 'ls-a' });
      broadcast('chat:message-chunk', 'BBB', { line: 'ls-b' });
      const aText = await ca.waitFor((s) => s.includes('AAA') || s.includes('BBB'), 600);
      const bText = await cb.waitFor((s) => s.includes('AAA') || s.includes('BBB'), 600);
      expect(aText).toContain('AAA');
      expect(aText).not.toContain('BBB');
      expect(bText).toContain('BBB');
      expect(bText).not.toContain('AAA');
    } finally {
      a.client.close();
      b.client.close();
    }
  });

  it('无 live 引擎的线(headless/已回收)= 全局 fan-out;无路由键 = 全局', async () => {
    __setLineLiveProbe(() => false); // 没有任何 live 引擎
    const a = createSseClient(() => {}, { line: 'ls-a' });
    const ca = makeCollector(a.response);
    try {
      // headless cron 线的事件——今天就是全员可达的,语义不变
      broadcast('chat:decision-request', { decisionId: 'd1', question: 'q', options: [], expertHits: [] }, { line: 'ls-cron' });
      expect(await ca.waitFor((s) => s.includes('decision-request'))).toContain('d1');
      // 真·全局事件(无路由键)
      broadcast('auto-run:started', { id: 'run-1' });
      expect(await ca.waitFor((s) => s.includes('auto-run:started'))).toContain('run-1');
    } finally {
      a.client.close();
    }
  });

  it('旧式全量订阅(不带 line)收一切——向后兼容', async () => {
    __setLineLiveProbe(() => true);
    const legacy = createSseClient(() => {});
    const c = makeCollector(legacy.response);
    try {
      broadcast('chat:status', { sessionState: 'idle', sessionId: 'ls-x' }, { line: 'ls-x' });
      expect(await c.waitFor((s) => s.includes('ls-x'))).toContain('ls-x');
    } finally {
      legacy.client.close();
    }
  });

  it('last-value cache 按线各存一份,重放只给本线订阅者', async () => {
    __setLineLiveProbe((line) => line === 'ls-a' || line === 'ls-b');
    broadcast('chat:status', { sessionState: 'running', sessionId: 'ls-b' }, { line: 'ls-b' });
    broadcast('chat:status', { sessionState: 'idle', sessionId: 'ls-a' }, { line: 'ls-a' });
    const a = createSseClient(() => {}, { line: 'ls-a' });
    const ca = makeCollector(a.response);
    try {
      // 200ms 重放延迟——窗口内聚合全部帧:有 ls-a 的 idle,绝无 ls-b 的 running
      const all = await ca.waitFor((s) => s.includes('ls-a'), 800);
      expect(all).toContain('ls-a');
      expect(all).not.toContain('ls-b');
    } finally {
      a.client.close();
    }
  });
});
