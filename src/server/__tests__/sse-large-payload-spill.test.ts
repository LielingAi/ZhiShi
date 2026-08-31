/**
 * 1.5.4 ① refs 大值外溢回归测试（CLAUDE.md 红线：>256KB payload 不直接进
 * SSE/IPC JSON）。
 *
 * 覆盖：
 *  (a) 超阈值 payload 经 maybeSpill 落盘，SSE 线上改发 {kind:'ref'} 占位，
 *      全文可由 fetchRef / 落盘文件取回（写链路真实生效）。
 *  (b) 未超阈值 payload 原样内联（不触发外溢）。
 *  (c) spill 在飞期间的后续事件排到串行尾链之后——事件时序不乱。
 *
 * 与 sse-backpressure.test.ts 同放 __tests__（stateful 池）：写盘路径经
 * ZHISHI_REFS_DIR 指向独占临时目录隔离。
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { broadcast, createSseClient } from '../sse';

let refsDir: string;

beforeAll(() => {
  refsDir = mkdtempSync(join(tmpdir(), 'zhishi-refs-test-'));
  process.env.ZHISHI_REFS_DIR = refsDir;
});

afterAll(() => {
  delete process.env.ZHISHI_REFS_DIR;
  rmSync(refsDir, { recursive: true, force: true });
});

/** 从 SSE 流读到目标事件帧为止（spill 是异步的，直接断言会竞态）。 */
async function readUntilEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  event: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for (let i = 0; i < 200; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
    if (out.includes(`event: ${event}\n`)) break;
  }
  return out;
}

describe('SSE 大 payload 外溢（maybeSpill → {kind:ref}）', () => {
  it('(a) 超 256KB 的 payload 落盘换引用，全文可经 fetchRef 取回', async () => {
    const { client, response } = createSseClient(() => { /* noop */ });
    const reader = response.body!.getReader();

    const big = { result: 'x'.repeat(300 * 1024) };
    broadcast('chat:tool-result-complete', big);

    const raw = await readUntilEvent(reader, 'chat:tool-result-complete');
    client.close();

    // 线上只有 ref 占位，绝不含全量文本（preview 只带 8KB 头——帧整体应远
    // 小于 307KB 的原始 payload）。
    expect(raw).toContain('"kind":"ref"');
    expect(raw.length).toBeLessThan(20 * 1024);

    const idMatch = raw.match(/"id":"([a-f0-9]{8,32})"/);
    expect(idMatch).not.toBeNull();

    // 写链路真实生效：ref 落盘，fetchRef 取回全量 JSON。
    const { fetchRef } = await import('../utils/large-value-store');
    const body = await fetchRef(idMatch![1]);
    expect(body).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(body!.data))).toEqual(big);
  });

  it('(b) 未超阈值的 payload 原样内联、不外溢', async () => {
    const { client, response } = createSseClient(() => { /* noop */ });
    const reader = response.body!.getReader();

    broadcast('chat:message-complete', { ok: true, marker: 'inline-stays' });

    const raw = await readUntilEvent(reader, 'chat:message-complete');
    client.close();

    expect(raw).toContain('"marker":"inline-stays"');
    expect(raw).not.toContain('"kind":"ref"');
  });

  it('(c) spill 在飞期间的后续事件不抢跑（尾链串行保时序）', async () => {
    const { client, response } = createSseClient(() => { /* noop */ });
    const reader = response.body!.getReader();

    // 同一帧序列里先发超大事件（触发异步 spill），紧跟一个小事件。
    // 若时序被打破，small-after-big 会先出现在流里。
    broadcast('chat:tool-result-complete', { result: 'y'.repeat(300 * 1024) });
    broadcast('chat:message-complete', { marker: 'after-spill' });

    const raw = await readUntilEvent(reader, 'chat:message-complete');
    client.close();

    const refIdx = raw.indexOf('"kind":"ref"');
    const afterIdx = raw.indexOf('"marker":"after-spill"');
    expect(refIdx).toBeGreaterThanOrEqual(0);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(refIdx).toBeLessThan(afterIdx);
  });
});
