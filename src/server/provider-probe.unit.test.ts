import { describe, expect, it } from 'vitest';

import {
  joinAnthropicMessagesUrl,
  anthropicAuthHeaders,
  summarizeProbeOutcome,
  composeVerifyFailureDetail,
  verifyTimeoutMessage,
  parseProviderError,
} from './provider-probe';

describe('joinAnthropicMessagesUrl — replicate SDK client.mjs buildURL (no /v1 dedupe)', () => {
  it('appends /v1/messages to a bare base', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com')).toBe('https://api.x.com/v1/messages');
  });
  it('collapses the double slash when base ends with /', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com/')).toBe('https://api.x.com/v1/messages');
  });
  it('DOES duplicate /v1 when the base already ends in /v1 (matches SDK → surfaces the same 404)', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com/v1')).toBe('https://api.x.com/v1/v1/messages');
  });
  it('duplicates /v1 with a trailing slash too', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com/v1/')).toBe('https://api.x.com/v1/v1/messages');
  });
});

describe('anthropicAuthHeaders — mirror agent-session auth mapping', () => {
  it('api_key → x-api-key only', () => {
    const h = anthropicAuthHeaders('api_key', 'sk-1');
    expect(h['x-api-key']).toBe('sk-1');
    expect(h['authorization']).toBeUndefined();
  });
  it('auth_token_clear_api_key → Bearer only', () => {
    const h = anthropicAuthHeaders('auth_token_clear_api_key', 'sk-2');
    expect(h['authorization']).toBe('Bearer sk-2');
    expect(h['x-api-key']).toBeUndefined();
  });
  it('both / default → both headers', () => {
    for (const t of ['both', undefined, 'auth_token'] as const) {
      const h = anthropicAuthHeaders(t, 'sk-3');
      expect(h['x-api-key']).toBe('sk-3');
      expect(h['authorization']).toBe('Bearer sk-3');
    }
  });
  it('always carries content-type + anthropic-version', () => {
    const h = anthropicAuthHeaders('both', 'k');
    expect(h['content-type']).toBe('application/json');
    expect(h['anthropic-version']).toBeTruthy();
  });
});

describe('summarizeProbeOutcome', () => {
  it('undefined → undefined', () => {
    expect(summarizeProbeOutcome(undefined)).toBeUndefined();
  });
  it('timedOut → timeout phrasing', () => {
    expect(summarizeProbeOutcome({ timedOut: true })).toContain('探测超时');
  });
  it('connectError → connect phrasing', () => {
    expect(summarizeProbeOutcome({ connectError: 'ECONNREFUSED' })).toContain('ECONNREFUSED');
  });
  it('status + body → HTTP + body', () => {
    const s = summarizeProbeOutcome({ status: 401, body: 'invalid api key' });
    expect(s).toContain('HTTP 401');
    expect(s).toContain('invalid api key');
  });
});

describe('composeVerifyFailureDetail — always non-empty (P0)', () => {
  it('never returns empty (stderr line guarantees content) and omits model when unset', () => {
    const d = composeVerifyFailureDetail({});
    expect(d).not.toContain('model:');
    expect(d).toContain('stderr');
    expect(d.length).toBeGreaterThan(0);
  });
  it('falls back to "无 stderr 输出" when stderr is empty', () => {
    expect(composeVerifyFailureDetail({ stderr: [] })).toContain('无 stderr 输出');
  });
  it('carries baseUrl, model, protocol, elapsed, stderr', () => {
    const d = composeVerifyFailureDetail({
      baseUrl: 'https://api.x.com',
      model: 'gpt-x',
      apiProtocol: 'openai',
      elapsedMs: 1234,
      stderr: ['boom'],
    });
    expect(d).toContain('baseUrl: https://api.x.com');
    expect(d).toContain('model: gpt-x');
    expect(d).toContain('protocol: openai');
    expect(d).toContain('elapsed: 1234ms');
    expect(d).toContain('boom');
  });
  it('labels a scoped bridge error as authoritative and prefers it over the weak one', () => {
    const d = composeVerifyFailureDetail({ scopedBridgeError: 'tls fail', weakBridgeError: 'other' });
    expect(d).toContain('bridge: tls fail');
    expect(d).not.toContain('other');
  });
  it('labels a weak (unconfirmed) bridge error explicitly', () => {
    const d = composeVerifyFailureDetail({ weakBridgeError: 'maybe-mine' });
    expect(d).toContain('未确认归属');
    expect(d).toContain('maybe-mine');
  });
  it('appends the diagnostic line', () => {
    expect(composeVerifyFailureDetail({ diagnostic: 'HTTP 402 余额不足' })).toContain('诊断探测: HTTP 402 余额不足');
  });
});

describe('verifyTimeoutMessage — honest copy, no false "请检查网络连接"', () => {
  it('scoped bridge error → connect message', () => {
    expect(verifyTimeoutMessage({ reason: 'timeout', hasProviderContext: true, scopedBridgeError: 'closed' }))
      .toBe('无法连接到供应商：closed');
  });
  it('provider timeout → "supplier did not respond", NOT a network-check message', () => {
    const m = verifyTimeoutMessage({ reason: 'timeout', hasProviderContext: true, timeoutMs: 30000 });
    expect(m).toContain('未响应');
    expect(m).not.toContain('请检查网络连接');
  });
  it('default provider timeout (no provider context) keeps the network-oriented copy', () => {
    expect(verifyTimeoutMessage({ reason: 'timeout', hasProviderContext: false }))
      .toBe('验证超时，请检查网络连接');
  });
  it('provider no-result → unparseable-response copy', () => {
    expect(verifyTimeoutMessage({ reason: 'no_result', hasProviderContext: true })).toContain('无法解析');
  });
  it('default provider no-result → plain copy', () => {
    expect(verifyTimeoutMessage({ reason: 'no_result', hasProviderContext: false })).toBe('验证未返回结果');
  });
});

describe('parseProviderError — 402/balance bucket + regression', () => {
  it('buckets 402 / balance / quota / insufficient / 欠费 / 余额 to the billing message', () => {
    for (const t of [
      'HTTP 402 payment required',
      'Insufficient Balance',
      'You exceeded your current quota',
      'insufficient_quota',
      '账户欠费',
      '余额不足',
    ]) {
      expect(parseProviderError(t.toLowerCase(), t).error).toBe('余额不足或账户欠费，请检查供应商账户');
    }
  });
  it('keeps raw text in detail', () => {
    expect(parseProviderError('insufficient balance', 'Insufficient Balance').detail).toBe('Insufficient Balance');
  });
  it('regression: 401 → key invalid, 403 → forbidden, 404 → model/url, 429 → rate limit', () => {
    expect(parseProviderError('401 unauthorized').error).toBe('API Key 无效或已过期');
    expect(parseProviderError('403 forbidden').error).toBe('访问被拒绝，请检查 API Key 权限');
    expect(parseProviderError('model not found').error).toBe('模型不存在或 API 地址错误');
    expect(parseProviderError('rate limit exceeded').error).toBe('请求频率限制，请稍后再试');
  });
  it('429 rate-limit still buckets to rate-limit (not billing) when no quota words present', () => {
    expect(parseProviderError('429 too many requests rate limit').error).toBe('请求频率限制，请稍后再试');
  });
});
