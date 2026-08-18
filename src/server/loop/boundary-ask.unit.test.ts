/**
 * boundary-ask 注册表 unit tests — 发起/应答/超时/重放/幂等。
 * broadcast 全注入,绝不触网。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  requestBoundaryAsk,
  respondBoundaryAsk,
  pendingBoundaryAsks,
  clearBoundaryAsks,
} from './boundary-ask';

afterEach(() => {
  clearBoundaryAsks();
  vi.restoreAllMocks();
});

describe('requestBoundaryAsk', () => {
  it('广播 chat:boundary-ask {askId, kind, objects} 并 pending 等答', async () => {
    const sent: { event: string; data: unknown }[] = [];
    const promise = requestBoundaryAsk(
      { kind: 'host-write', objects: ['pwn-vm:/tmp/exp.py', '→ 宿主 output/'] },
      (event, data) => sent.push({ event, data }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe('chat:boundary-ask');
    const view = sent[0].data as { askId: string; kind: string; objects: string[] };
    expect(view.kind).toBe('host-write');
    expect(view.objects).toHaveLength(2);
    expect(pendingBoundaryAsks().map((a) => a.askId)).toContain(view.askId);

    respondBoundaryAsk(view.askId, true);
    await expect(promise).resolves.toBe(true);
    expect(pendingBoundaryAsks()).toHaveLength(0);
  });

  it('拒绝应答 → resolve(false)', async () => {
    const sent: { event: string; data: unknown }[] = [];
    const promise = requestBoundaryAsk({ kind: 'destroy-env', objects: ['pwn-vm'] }, (e, d) =>
      sent.push({ event: e, data: d }),
    );
    const askId = (sent[0].data as { askId: string }).askId;
    respondBoundaryAsk(askId, false);
    await expect(promise).resolves.toBe(false);
  });

  it('超时自动拒绝 + 广播 chat:boundary-expired', async () => {
    const sent: { event: string; data: unknown }[] = [];
    const promise = requestBoundaryAsk(
      { kind: 'host-write', objects: [], timeoutMs: 30 },
      (e, d) => sent.push({ event: e, data: d }),
    );
    await expect(promise).resolves.toBe(false);
    expect(sent.map((s) => s.event)).toEqual(['chat:boundary-ask', 'chat:boundary-expired']);
  });

  it('重复/未知 askId 应答 → false(幂等)', async () => {
    const sent: { event: string; data: unknown }[] = [];
    const promise = requestBoundaryAsk({ kind: 'local-cred', objects: [] }, (e, d) =>
      sent.push({ event: e, data: d }),
    );
    const askId = (sent[0].data as { askId: string }).askId;
    expect(respondBoundaryAsk(askId, true)).toBe(true);
    expect(respondBoundaryAsk(askId, true)).toBe(false); // 已答
    expect(respondBoundaryAsk('ask-nope', true)).toBe(false); // 未知
    await expect(promise).resolves.toBe(true);
  });
});
