// Unit tests for the viewport state machine (design-spec §6.3: 无模式回看).
import { describe, expect, it } from 'vitest';

import { Viewport } from './viewport';

function makeVp(height = 5, width = 80) {
  return new Viewport({ width, height });
}

function fill(vp: Viewport, n: number) {
  vp.appendRows(n);
  vp.syncTotal(vp.state().total);
}

describe('follow the tail', () => {
  it('starts pinned to the bottom with an empty window', () => {
    const vp = makeVp();
    expect(vp.state()).toMatchObject({
      total: 0,
      scrollOffset: 0,
      newCount: 0,
      following: true,
    });
    expect(vp.window()).toEqual({ start: 0, end: 0 });
  });

  it('window shows all rows while content fits', () => {
    const vp = makeVp(5);
    fill(vp, 3);
    expect(vp.window()).toEqual({ start: 0, end: 3 });
  });

  it('window tracks the tail once content overflows', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    expect(vp.window()).toEqual({ start: 7, end: 12 });
    expect(vp.state().following).toBe(true);
  });
});

describe('scroll up pauses following', () => {
  it('window freezes, appends no longer drag, new messages count', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    vp.scrollBy(3);
    expect(vp.window()).toEqual({ start: 4, end: 9 });
    expect(vp.state().following).toBe(false);

    vp.appendRows(4);
    expect(vp.window()).toEqual({ start: 4, end: 9 }); // view stands still
    expect(vp.state().newCount).toBe(4);
  });

  it('clamps at the top', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    vp.scrollBy(999);
    expect(vp.window()).toEqual({ start: 0, end: 5 });
    expect(vp.state().scrollOffset).toBe(7);
  });

  it('scrollToTop lands on the first page', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    vp.scrollToTop();
    expect(vp.window()).toEqual({ start: 0, end: 5 });
  });

  it('no scrolling while content fits the screen', () => {
    const vp = makeVp(5);
    fill(vp, 3);
    vp.scrollBy(2);
    expect(vp.state().scrollOffset).toBe(0);
    expect(vp.window()).toEqual({ start: 0, end: 3 });
  });
});

describe('scroll back to bottom resumes following', () => {
  it('partial scroll keeps the count; reaching bottom clears it', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    vp.scrollBy(4);
    vp.appendRows(6); // view stands still; offset grows to 10
    expect(vp.state().newCount).toBe(6);
    expect(vp.window()).toEqual({ start: 3, end: 8 });

    vp.scrollBy(-1);
    expect(vp.state().following).toBe(false);
    expect(vp.state().newCount).toBe(6);

    vp.scrollBy(-9); // hits bottom
    expect(vp.state().following).toBe(true);
    expect(vp.state().newCount).toBe(0);
    expect(vp.window()).toEqual({ start: 13, end: 18 });
  });

  it('scrollToTail snaps to the newest rows', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    vp.scrollToTop();
    vp.appendRows(3);
    vp.scrollToTail();
    expect(vp.window()).toEqual({ start: 10, end: 15 });
    expect(vp.state().newCount).toBe(0);
  });

  it('scrollPages moves by one screenful', () => {
    const vp = makeVp(5);
    fill(vp, 20);
    vp.scrollPages(2);
    expect(vp.state().scrollOffset).toBe(10);
    vp.scrollPages(-1);
    expect(vp.state().scrollOffset).toBe(5);
  });
});

describe('resize & reflow', () => {
  it('height shrink clamps the offset', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    vp.scrollToTop(); // offset 7
    vp.resize({ width: 80, height: 10 });
    expect(vp.state().scrollOffset).toBe(2); // total 12 - height 10
  });

  it('reflow (rewrap) keeps a follower glued to the tail', () => {
    const vp = makeVp(5);
    fill(vp, 8);
    vp.syncTotal(16); // narrower width doubled the visual rows
    expect(vp.window()).toEqual({ start: 11, end: 16 });
    expect(vp.state().following).toBe(true);
  });

  it('reflow keeps a reader at their (clamped) offset', () => {
    const vp = makeVp(5);
    fill(vp, 20);
    vp.scrollBy(6); // viewing 9..14 of 20
    vp.syncTotal(40); // rewrap doubled rows
    expect(vp.state().scrollOffset).toBe(6);
    expect(vp.window()).toEqual({ start: 29, end: 34 });
  });

  it('content shrinking below the view clamps the offset', () => {
    const vp = makeVp(5);
    fill(vp, 12);
    vp.scrollBy(4);
    vp.syncTotal(3); // e.g. buffer eviction + rewrap
    expect(vp.state().scrollOffset).toBe(0);
  });
});
