/**
 * 多会话并存状态机单测（1.3.2 任务三 A 形态）：
 * 换激活指针、不丢任何线的本地状态（含未完成渲染的流）、同线切换无操作。
 */

import { describe, expect, it } from 'vitest';

import { emptySession, type SessionState } from './blocks';
import { ensureSessionSlot, planSwitch, sessionKey } from './multi-session';

function sessionWith(items: SessionState['items'] = []): SessionState {
  const s = emptySession();
  s.items = items;
  s.streamingTurnId = 'turn-1';
  return s;
}

describe('sessionKey / ensureSessionSlot', () => {
  it('null/空 → host 键；环境 id 原样', () => {
    expect(sessionKey(null)).toBe('host');
    expect(sessionKey('')).toBe('host');
    expect(sessionKey('pwn-vm')).toBe('pwn-vm');
  });

  it('缺槽补 emptySession；已有槽返回原引用', () => {
    const s = { host: emptySession() };
    expect(ensureSessionSlot(s, 'host')).toBe(s);
    const s2 = ensureSessionSlot(s, 'pwn-vm');
    expect(s2).not.toBe(s);
    expect(s2['pwn-vm']).toEqual(emptySession());
    expect(s2.host).toBe(s.host); // 别线不受影响
  });
});

describe('planSwitch（切换状态机）', () => {
  it('目标线 = 当前线 → changed=false（免重连）', () => {
    const sessions = { 'pwn-vm': sessionWith() };
    const plan = planSwitch('pwn-vm', sessions, 'pwn-vm');
    expect(plan.changed).toBe(false);
    expect(plan.sessions).toBe(sessions);
  });

  it('切换保留目标线现有状态（含未完成渲染的流）', () => {
    const live = sessionWith([{ kind: 'divider', id: 'd1', seq: 1, text: '⏸' }]);
    const sessions = { host: sessionWith(), 'pwn-vm': live };
    const plan = planSwitch('host', sessions, 'pwn-vm');
    expect(plan.changed).toBe(true);
    expect(plan.envKey).toBe('pwn-vm');
    expect(plan.sessions['pwn-vm']).toBe(live); // 原引用保留——状态不丢
    expect(plan.sessions.host).toBe(sessions.host); // 旧激活线原样冻结
  });

  it('切走再切回：两条线各自独立、互不覆盖', () => {
    const a = sessionWith();
    const b = sessionWith();
    let sessions: Record<string, SessionState> = { host: a, 'pwn-vm': b };
    sessions = planSwitch(null, sessions, 'pwn-vm').sessions; // host → pwn-vm
    sessions = planSwitch('pwn-vm', sessions, 'rev').sessions; // pwn-vm → rev
    expect(Object.keys(sessions).sort()).toEqual(['host', 'pwn-vm', 'rev']);
    expect(sessions.host).toBe(a);
    expect(sessions['pwn-vm']).toBe(b);
    // 切回 host：目标线状态仍在
    const back = planSwitch('rev', sessions, null);
    expect(back.envKey).toBeNull();
    expect(back.sessions.host).toBe(a);
  });

  it('切到宿主线（null）也换激活指针', () => {
    const plan = planSwitch('pwn-vm', { 'pwn-vm': sessionWith() }, null);
    expect(plan.changed).toBe(true);
    expect(plan.envKey).toBeNull();
    expect(plan.sessions.host).toBeDefined();
  });
});
