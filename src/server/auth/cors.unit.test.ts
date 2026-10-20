/**
 * cors 单测（1.8.7 P1 建立；2.0.6 随 allowlist 阻断回退更新）：
 *  - auth disabled：预检/响应逐字节保持 1.8.6 的 ACAO:*；
 *  - auth enabled：预检/响应**回显任意来源 origin**（token 才是真门；
 *    allowlist 阻断曾把 webview 锁死——见 cors.ts 模块头实机事故）；
 *    无 Origin 头（CLI/Rust 代理）仍 403（预检）/ 原样（响应）。
 *  - isAllowedBrowserOrigin 保留（审计），其清单语义不变。
 */
import { describe, expect, it } from 'vitest';

import { applyCorsDecision, isAllowedBrowserOrigin, preflightResponse } from './cors';

describe('isAllowedBrowserOrigin（审计清单，2.0.6 起不参与阻断）', () => {
  it('allowlist：Tauri webview 形态 + 回环 http(s)', () => {
    for (const o of [
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'http://127.0.0.1:1420',
      'http://localhost:1420',
      'http://[::1]:3000',
      'https://127.0.0.1:443',
    ]) {
      expect(isAllowedBrowserOrigin(o), o).toBe(true);
    }
  });

  it('拒绝：外部 origin / 非 http(s) / 坏形状', () => {
    for (const o of ['https://evil.example.com', 'http://10.0.0.8:7411', 'file:///etc/passwd', 'javascript:alert(1)', '', 'not a url']) {
      expect(isAllowedBrowserOrigin(o), o).toBe(false);
    }
  });
});

describe('preflightResponse', () => {
  it('auth disabled → 与 1.8.6 逐字节一致（ACAO:*）', () => {
    const res = preflightResponse('https://evil.example.com', false);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
  });

  it('auth enabled + 任意 origin → 204 回显 + Vary（allowlist 命中与否都一样）', () => {
    for (const origin of ['http://tauri.localhost', 'http://127.0.0.1:1420', 'https://tauri.localhost', 'https://odd-origin.example']) {
      const res = preflightResponse(origin, true);
      expect(res.status, origin).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBe(origin);
      expect(res.headers.get('Vary'), origin).toBe('Origin');
      expect(res.headers.get('Access-Control-Allow-Headers'), origin).toBe('Content-Type, Authorization');
    }
  });

  it('auth enabled + 无 origin → 403（浏览器预检必带 Origin，缺失即非浏览器）', () => {
    const res = preflightResponse(null, true);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('applyCorsDecision', () => {
  function jsonResp(): Response {
    // 模拟 jsonResponse 现状（ACAO:* 硬编码）
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  it('auth disabled → 原样返回（同一 Response 实例）', () => {
    const res = jsonResp();
    expect(applyCorsDecision('https://evil.example.com', false, res)).toBe(res);
  });

  it('无 Origin（CLI/Rust 代理）→ 原样返回', () => {
    const res = jsonResp();
    expect(applyCorsDecision(null, true, res)).toBe(res);
  });

  it('auth enabled → 任意 origin ACAO 回显 + Vary，状态/body 保留', async () => {
    const res = applyCorsDecision('http://127.0.0.1:1420', true, jsonResp());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:1420');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });

  it('2.0.6：非 allowlist origin 同样回显（不再摘 ACAO——曾把 webview 锁死）', async () => {
    const res = applyCorsDecision('https://odd-origin.example', true, jsonResp());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://odd-origin.example');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });
});
