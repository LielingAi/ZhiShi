/**
 * 环境准入闸单测（1.3.1 ①）。
 */

import { describe, expect, it } from 'vitest';

import { accessGate, canStartEntry, gateToast, hostAnchorLabel, initAnchorToGuiKey, selectionToGuiKey } from './access-gate';
import type { SidebarEnvItem } from './envs';

function item(partial: Partial<SidebarEnvItem>): SidebarEnvItem {
  return {
    key: 'e',
    label: 'e',
    group: 'stop',
    detail: '',
    kind: 'docker',
    warn: false,
    startable: false,
    ...partial,
  };
}

describe('accessGate', () => {
  it('运行中 → 放行', () => {
    expect(accessGate(item({ group: 'run' }))).toEqual({ allow: true });
  });

  it('已停止 → 拦截（not-started），可启动性跟随 startable', () => {
    expect(accessGate(item({ group: 'stop', startable: true }))).toEqual({
      allow: false,
      reason: 'not-started',
      canStart: true,
    });
    expect(accessGate(item({ group: 'stop' }))).toEqual({
      allow: false,
      reason: 'not-started',
      canStart: false,
    });
  });

  it('本机已有（未登记）→ 拦截（unregistered）', () => {
    expect(accessGate(item({ group: 'unreg' }))).toEqual({ allow: false, reason: 'unregistered' });
  });
});

describe('gateToast / canStartEntry', () => {
  it('拦截文案与原因对应', () => {
    expect(gateToast(item({ group: 'unreg' }), { allow: false, reason: 'unregistered' })).toBe(
      '未登记，请先在新建环境里接入',
    );
    expect(gateToast(item({ group: 'stop' }), { allow: false, reason: 'not-started', canStart: false })).toBe(
      '环境未启动，先启动再进入',
    );
  });

  it('启动按钮只在 stop + startable 时可见', () => {
    expect(canStartEntry(item({ group: 'stop', startable: true }))).toBe(true);
    expect(canStartEntry(item({ group: 'stop', startable: false }))).toBe(false);
    expect(canStartEntry(item({ group: 'run', startable: true }))).toBe(false);
  });
});

describe('hostAnchorLabel', () => {
  it('null/空 → 宿主 · 未锚定环境', () => {
    expect(hostAnchorLabel(null)).toBe('宿主 · 未锚定环境');
    expect(hostAnchorLabel('')).toBe('宿主 · 未锚定环境');
    expect(hostAnchorLabel(undefined)).toBe('宿主 · 未锚定环境');
  });

  it('锚定环境 → 原样', () => {
    expect(hostAnchorLabel('pwn@docker')).toBe('pwn@docker');
  });
});

describe('selectionToGuiKey', () => {
  it('host → null', () => {
    expect(selectionToGuiKey({ kind: 'host' })).toBeNull();
    expect(selectionToGuiKey(null)).toBeNull();
    expect(selectionToGuiKey(undefined)).toBeNull();
  });

  it('env → id', () => {
    expect(selectionToGuiKey({ kind: 'env', id: 'pwn-vm' })).toBe('pwn-vm');
  });

  it('recipe → instanceId（up 回写条目 id = 实例名）', () => {
    expect(
      selectionToGuiKey({ kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' }),
    ).toBe('zhishi-pwn-a3f2');
  });

  it('未知形状回落宿主线（不猜）', () => {
    expect(selectionToGuiKey({ kind: 'weird' })).toBeNull();
    expect(selectionToGuiKey({ kind: 'env' })).toBeNull();
  });
});

describe('initAnchorToGuiKey（1.3.2 任务二 #2：chat:init environment 锚）', () => {
  it('host（null）→ null', () => {
    expect(initAnchorToGuiKey(null)).toBeNull();
    expect(initAnchorToGuiKey(undefined)).toBeNull();
  });

  it('env → id；recipe → id（即 instanceId，与 selectionToGuiKey 同口径）', () => {
    expect(initAnchorToGuiKey({ kind: 'env', id: 'pwn-vm', name: 'pwn-vm', type: 'vm' })).toBe('pwn-vm');
    expect(
      initAnchorToGuiKey({ kind: 'recipe', id: 'zhishi-pwn-a3f2', name: 'zhishi-pwn-a3f2', type: 'pwn-vm' }),
    ).toBe('zhishi-pwn-a3f2');
  });

  it('未知形状回落宿主线（不猜）', () => {
    expect(
      initAnchorToGuiKey({ kind: 'host', id: 'x', name: '', type: '' } as unknown as {
        kind: 'env' | 'recipe';
        id: string;
        name: string;
        type: string;
      }),
    ).toBeNull();
    expect(initAnchorToGuiKey({ kind: 'env', id: '', name: '', type: '' })).toBeNull();
  });
});
