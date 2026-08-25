/**
 * Esc 链优先级单测（1.3.1 ②③④ 扩展）：一次弹一层，顺序
 * overlay > tasks > queue > boundary > modal > drawer > page > busy 中断 > none。
 */

import { describe, expect, it } from 'vitest';

import { escAction } from './esc-chain';

const base = {
  overlayOpen: false,
  tasksOpen: false,
  queueOpen: false,
  boundaryOpen: false,
  modalOpen: false,
  drawerOpen: false,
  pageOpen: false,
  busy: false,
};

describe('escAction', () => {
  it('overlay 优先于一切', () => {
    expect(
      escAction({
        ...base,
        overlayOpen: true,
        tasksOpen: true,
        boundaryOpen: true,
        modalOpen: true,
        drawerOpen: true,
        pageOpen: true,
        busy: true,
      }),
    ).toEqual({ type: 'close-overlay' });
  });

  it('tasks 面板次之（boundary 模态同时存在时不抢层）', () => {
    expect(escAction({ ...base, tasksOpen: true, boundaryOpen: true })).toEqual({ type: 'close-tasks' });
  });

  it('queue 面板在 tasks 之后', () => {
    expect(escAction({ ...base, queueOpen: true, boundaryOpen: true })).toEqual({ type: 'close-queue' });
  });

  it('boundary 模态进链：在 modal 之前', () => {
    expect(escAction({ ...base, boundaryOpen: true, modalOpen: true })).toEqual({ type: 'close-boundary' });
    expect(escAction({ ...base, boundaryOpen: true, drawerOpen: true, busy: true })).toEqual({
      type: 'close-boundary',
    });
  });

  it('modal 次之', () => {
    expect(escAction({ ...base, modalOpen: true, drawerOpen: true, pageOpen: true, busy: true })).toEqual({
      type: 'close-modal',
    });
  });

  it('drawer 再次之', () => {
    expect(escAction({ ...base, drawerOpen: true, pageOpen: true, busy: true })).toEqual({ type: 'close-drawer' });
  });

  it('page（设置/attach）在 drawer 之后', () => {
    expect(escAction({ ...base, pageOpen: true, busy: true })).toEqual({ type: 'close-page' });
  });

  it('无面板且 busy → 中断 turn', () => {
    expect(escAction({ ...base, busy: true })).toEqual({ type: 'interrupt' });
  });

  it('无面板且空闲 → none', () => {
    expect(escAction(base)).toEqual({ type: 'none' });
  });

  it('面板存在时 busy 不触发中断（一层一层弹）', () => {
    expect(escAction({ ...base, overlayOpen: true, busy: true })).toEqual({ type: 'close-overlay' });
    expect(escAction({ ...base, drawerOpen: true, busy: true })).toEqual({ type: 'close-drawer' });
  });
});
