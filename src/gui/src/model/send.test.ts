/**
 * 发送 / 纠偏语义单测。
 */

import { describe, expect, it } from 'vitest';

import { buildSendBody, classifySendResponse } from './send';

describe('buildSendBody', () => {
  it('trim 文本；空 refs 不带字段（服务端 additive 语义）', () => {
    expect(buildSendBody('  hello  ', [])).toEqual({ text: 'hello' });
  });

  it('带 refs 时透传', () => {
    expect(buildSendBody('查一下', [{ type: 'env', id: 'pwn@docker' }])).toEqual({
      text: '查一下',
      refs: [{ type: 'env', id: 'pwn@docker' }],
    });
  });
});

describe('classifySendResponse（服务端裁决的 steering 契约）', () => {
  it('steering:true → 纠偏（busy 时服务端自动进 steering 队列）', () => {
    expect(classifySendResponse({ queued: true, steering: true, isInFlight: false })).toBe(
      'steering',
    );
  });

  it('isInFlight → 直接开跑', () => {
    expect(classifySendResponse({ queued: false, isInFlight: true })).toBe('started');
  });

  it('queued 且无 steering → FIFO 排队', () => {
    expect(classifySendResponse({ queued: true, steering: false, isInFlight: false })).toBe('fifo-queued');
  });

  it('缺省视为 started（服务端正常回包形状）', () => {
    expect(classifySendResponse({})).toBe('started');
  });
});
