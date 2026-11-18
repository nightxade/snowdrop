import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingAnchor, SCROLLING_MS } from './readingAnchor';

/** A scroller whose messages sit at the given tops (px below its own top, which is 100). */
function list(tops: Record<string, number>, height = 50) {
  const scroller = document.createElement('div');
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 600 }) as DOMRect;
  const set = (next: Record<string, number>) => {
    scroller.replaceChildren();
    for (const [id, top] of Object.entries(next)) {
      const el = document.createElement('div');
      el.dataset.messageId = id;
      el.getBoundingClientRect = () => ({ top: 100 + top, bottom: 100 + top + height }) as DOMRect;
      scroller.append(el);
    }
  };
  set(tops);
  return { scroller, set };
}

/** An anchor on a clock (and timers) the test moves. */
function anchored() {
  const clock = { now: 0 };
  return {
    anchor: new ReadingAnchor(() => clock.now),
    wait: (ms: number) => {
      clock.now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ReadingAnchor', () => {
  it('puts the first message in view back when a row above it grew', () => {
    const { scroller, set } = list({ a: -80, b: 20, c: 90 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS);
    // `a` is above the view and `b` is the first in view; a reaction above pushes both down 30 px.
    set({ a: -50, b: 50, c: 120 });
    expect(anchor.drift(scroller, 0)).toBe(30);
    // A row above shrank (a delete).
    set({ a: -80, b: 10, c: 80 });
    expect(anchor.drift(scroller, 0)).toBe(-10);
  });

  it('anchors on the first message that starts in view: one cut off by the top edge is above the reader', () => {
    const { scroller, set } = list({ a: -30, b: 40 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS);
    // A reaction on the cut-off message pushes the one after it down; the reader's message is `b`.
    set({ a: -30, b: 70 });
    expect(anchor.drift(scroller, 0)).toBe(30);
  });

  it('anchors on a message so tall that none starts in view', () => {
    const { scroller, set } = list({ a: -30 }, 400);
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS);
    set({ a: -10 });
    expect(anchor.drift(scroller, 0)).toBe(20);
  });

  it('takes its place once the list is still, not at the scroll event (rows are placed after a jump)', () => {
    const { scroller, set } = list({ x: 10 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS - 1);
    // The virtualiser puts other rows on screen after the jump.
    set({ a: 10, b: 60 });
    wait(1);
    set({ a: 40, b: 90 });
    expect(anchor.drift(scroller, 0)).toBe(30);
  });

  it('says nothing while the list is being scrolled, and takes the new place as its own', () => {
    const { scroller, set } = list({ a: 10, b: 60 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS);
    anchor.noteScroll(scroller, 0);
    set({ a: 40, b: 90 });
    wait(SCROLLING_MS - 1);
    expect(anchor.drift(scroller, 0)).toBe(0);
    wait(SCROLLING_MS);
    // The place it took is the one it keeps.
    expect(anchor.drift(scroller, 0)).toBe(0);
    set({ a: 45, b: 95 });
    expect(anchor.drift(scroller, 0)).toBe(5);
  });

  it('leaves the view to the virtualiser when older history was prepended', () => {
    const { scroller, set } = list({ a: 10, b: 60 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 100);
    wait(SCROLLING_MS);
    set({ a: 310, b: 360 });
    expect(anchor.drift(scroller, 80)).toBe(0);
    wait(SCROLLING_MS);
    set({ a: 330, b: 380 });
    expect(anchor.drift(scroller, 80)).toBe(20);
  });

  it('says nothing when its message is no longer rendered, or there was none', () => {
    const { scroller, set } = list({});
    const { anchor, wait } = anchored();
    expect(anchor.drift(scroller, 0)).toBe(0);
    wait(SCROLLING_MS);
    set({ a: 10, b: 60 });
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS);
    set({ b: 90 });
    expect(anchor.drift(scroller, 0)).toBe(0);
    wait(SCROLLING_MS);
    set({ b: 100 });
    expect(anchor.drift(scroller, 0)).toBe(10);
  });

  it('scrolls the list by the drift', () => {
    const { scroller, set } = list({ a: 10, b: 60 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS);
    scroller.scrollTop = 200;
    set({ a: 40, b: 90 });
    anchor.hold(scroller, 0);
    expect(scroller.scrollTop).toBe(230);
  });

  it('does not take its own correction for the reader scrolling: a second change soon after is corrected too', () => {
    const { scroller, set } = list({ a: 10, b: 60 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    wait(SCROLLING_MS);
    scroller.scrollTop = 200;
    set({ a: 40, b: 90 });
    anchor.hold(scroller, 0);
    expect(scroller.scrollTop).toBe(230);
    // The scroll event the correction causes, then the content settles back under the reader.
    anchor.noteScroll(scroller, 0);
    set({ a: 10, b: 60 });
    wait(50);
    set({ a: 35, b: 85 });
    anchor.hold(scroller, 0);
    expect(scroller.scrollTop).toBe(255);
    // A scroll by the reader (a different position) still holds the anchor back.
    anchor.noteScroll(scroller, 0);
    scroller.scrollTop = 100;
    anchor.noteScroll(scroller, 0);
    set({ a: 40, b: 90 });
    anchor.hold(scroller, 0);
    expect(scroller.scrollTop).toBe(100);
  });

  it('takes no place after it is disposed', () => {
    const { scroller, set } = list({ a: 10 });
    const { anchor, wait } = anchored();
    anchor.noteScroll(scroller, 0);
    anchor.dispose();
    wait(SCROLLING_MS);
    set({ a: 40 });
    expect(anchor.drift(scroller, 0)).toBe(0);
  });
});
