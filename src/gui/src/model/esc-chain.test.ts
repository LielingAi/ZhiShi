/**
 * Esc 链优先级单测：一次弹一层，顺序
 * overlay > modal > drawer > page > busy 中断 > none。
 */

import { describe, expect, it } from 'vitest';

import { escAction } from './esc-chain';

const base = {
  overlayOpen: false,
  modalOpen: false,
  drawerOpen: false,
  pageOpen: false,
  busy: false,
};

describe('escAction', () => {
  it('overlay 优先于一切', () => {
    expect(
      escAction({ ...base, overlayOpen: true, modalOpen: true, drawerOpen: true, pageOpen: true, busy: true }),
    ).toEqual({ type: 'close-overlay' });
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
