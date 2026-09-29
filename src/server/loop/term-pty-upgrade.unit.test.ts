/**
 * term WS upgrade 鉴权闸单测（1.8.7 P1，设计稿 R1 点名的「最容易漏的一针」）。
 *
 * 不绑真实端口：installTermUpgradeHandler 只在 server 上挂 'upgrade' 监听，
 * 用 EventEmitter + fake socket 直接驱动。authVerify 注入 fake——闸本身的
 * 判定逻辑在 gate.unit.test.ts 覆盖，这里只钉死「upgrade 路径确实过闸 +
 * header/query 两种 token 通道 + 拒绝时的 HTTP 应答形态」。
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { installTermUpgradeHandler, TERM_WS_PATH, type TermUpgradeAuthVerify } from './term-pty';

interface FakeSocket {
  written: string[];
  destroyed: boolean;
}

function makeHarness(authVerify: TermUpgradeAuthVerify) {
  const server = new EventEmitter();
  // installTermUpgradeHandler 只用到 server.on——EventEmitter 结构兼容。
  // envResolver 返回 null：过闸后的 attach 走「未找到环境」fail 路径，
  // 不会真 spawn pty。
  installTermUpgradeHandler(
    server as unknown as import('node:http').Server,
    { envResolver: () => null, log: () => {} },
    authVerify,
  );
  const fire = (url: string, headers: Record<string, string> = {}): FakeSocket => {
    const socket: FakeSocket = { written: [], destroyed: false };
    server.emit(
      'upgrade',
      { url, headers },
      {
        write: (s: string) => { socket.written.push(s); return true; },
        destroy: () => { socket.destroyed = true; },
        // ws.handleUpgrade 需要完整 socket 形态（过闸后才走到；它拿到假
        // handshake 会按 400 中止——与鉴权闸的 401/403 区分得开）。
        on: () => {},
        removeListener: () => {},
        setTimeout: () => {},
        setNoDelay: () => {},
        end: () => {},
      },
      Buffer.alloc(0),
    );
    return socket;
  };
  return { fire };
}

describe('WS upgrade 鉴权闸', () => {
  it('auth disabled（verify 放行）→ upgrade 不被 401/403 拦截', () => {
    const { fire } = makeHarness(() => ({ ok: true }));
    // 不带 env：过闸后停在 env 校验（HTTP 400）——证明没被闸拒，也不进 ws 内部。
    const socket = fire(TERM_WS_PATH);
    expect(socket.written.join('')).toContain('HTTP/1.1 400 Bad Request');
    expect(socket.destroyed).toBe(true);
  });

  it('verify 拒绝 401 → 写 HTTP 401 并 destroy（header 通道）', () => {
    let seen: { authorization?: string | null; queryToken?: string | null } = {};
    const { fire } = makeHarness((input) => {
      seen = input;
      return { ok: false, status: 401 };
    });
    const socket = fire(`${TERM_WS_PATH}?env=x`, { authorization: 'Bearer zst_bad' });
    expect(socket.written.join('')).toContain('HTTP/1.1 401 Unauthorized');
    expect(socket.destroyed).toBe(true);
    expect(seen.authorization).toBe('Bearer zst_bad');
  });

  it('verify 拒绝 403 → 写 HTTP 403 并 destroy', () => {
    const { fire } = makeHarness(() => ({ ok: false, status: 403 }));
    const socket = fire(`${TERM_WS_PATH}?env=x`, { authorization: 'Bearer zst_readonly' });
    expect(socket.written.join('')).toContain('HTTP/1.1 403 Forbidden');
    expect(socket.destroyed).toBe(true);
  });

  it('?token= query 兜底传给 verify（浏览器 WS 不能自定义头）', () => {
    let seen: { queryToken?: string | null } = {};
    const { fire } = makeHarness((input) => {
      seen = input;
      return { ok: false, status: 401 };
    });
    fire(`${TERM_WS_PATH}?env=x&token=zst_query`, {});
    expect(seen.queryToken).toBe('zst_query');
  });

  it('非 term 路径的 upgrade 依旧直接 destroy（不过闸）', () => {
    let called = false;
    const { fire } = makeHarness(() => {
      called = true;
      return { ok: true };
    });
    const socket = fire('/other-ws');
    expect(socket.destroyed).toBe(true);
    expect(called).toBe(false);
  });
});
