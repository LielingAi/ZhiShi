/**
 * cors 单测（1.8.7 P1）：两模式行为——
 *  - auth disabled：预检/响应逐字节保持 1.8.6 的 ACAO:*；
 *  - auth enabled：allowlist（Tauri webview + 回环 http(s)）echo origin，
 *    其余 origin 预检 403、响应摘 ACAO；无 Origin（CLI/Rust 代理）原样。
 */
import { describe, expect, it } from 'vitest';

import { applyCorsDecision, isAllowedBrowserOrigin, preflightResponse } from './cors';

describe('isAllowedBrowserOrigin', () => {
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

  it('auth enabled + allowlist origin → 204 echo + Vary', () => {
    const res = preflightResponse('http://tauri.localhost', true);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
  });

  it('auth enabled + 非 allowlist / 无 origin → 403 且无 ACAO', () => {
    for (const origin of ['https://evil.example.com', null]) {
      const res = preflightResponse(origin, true);
      expect(res.status).toBe(403);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
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

  it('allowlist origin → ACAO echo + Vary，状态/body 保留', async () => {
    const res = applyCorsDecision('http://127.0.0.1:1420', true, jsonResp());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:1420');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });

  it('非 allowlist origin → 摘掉 ACAO', () => {
    const res = applyCorsDecision('https://evil.example.com', true, jsonResp());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.status).toBe(200);
  });
});
