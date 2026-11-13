import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingMessageId, type RenderItem } from '@/core/domain';
import { BottomPin } from './bottomPin';
import { startedOwnSend, useFollowOwnSend } from './useFollowOwnSend';

const row = (key: string, id: string, authorId = 'me'): RenderItem => ({
  type: 'message',
  key,
  id: id as never,
  authorId,
  continuation: false,
});
const sending = (nonce: string): RenderItem => row(nonce, pendingMessageId(nonce));

describe('startedOwnSend', () => {
  const was = { epoch: 0, key: 'a' };
  it('is a pending row newly at the end of the same list', () => {
    expect(startedOwnSend(was, { epoch: 0, key: 'n1', pending: true })).toBe(true);
  });
  it('is not a message that arrived, or one that was already last', () => {
    expect(startedOwnSend(was, { epoch: 0, key: 'b', pending: false })).toBe(false);
    expect(startedOwnSend(was, { epoch: 0, key: 'a', pending: true })).toBe(false);
  });
  it('is not a list being opened (nothing shown before, or another epoch)', () => {
    expect(startedOwnSend(null, { epoch: 0, key: 'n1', pending: true })).toBe(false);
    expect(startedOwnSend(was, { epoch: 1, key: 'n1', pending: true })).toBe(false);
  });
});

describe('useFollowOwnSend', () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const flush = () => {
    const run = frames;
    frames = [];
    for (const cb of run) cb(0);
  };

  function setup(items: RenderItem[]) {
    const pin = new BottomPin(false);
    const scrollToBottom = vi.fn();
    const scrollTopNow = () => 300;
    const view = renderHook(
      (props: { items: RenderItem[]; epoch: number; anchoredToPresent: boolean }) => {
        useFollowOwnSend({ ...props, pin, scrollTopNow, scrollToBottom });
      },
      { initialProps: { items, epoch: 0, anchoredToPresent: true } },
    );
    return { pin, scrollToBottom, view };
  }

  it('holds the bottom and scrolls to a message the moment its pending row appears', () => {
    const { pin, scrollToBottom, view } = setup([row('a', 'm-a'), row('b', 'm-b')]);
    // The reader had scrolled up; sending brings them back.
    expect(pin.isStuck).toBe(false);
    act(() => {
      view.rerender({
        items: [row('a', 'm-a'), row('b', 'm-b'), sending('n1')],
        epoch: 0,
        anchoredToPresent: true,
      });
    });
    expect(pin.isStuck).toBe(true);
    act(flush);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a message from someone else, or a list that is only opening', () => {
    const { pin, scrollToBottom, view } = setup([row('a', 'm-a')]);
    act(() => {
      view.rerender({
        items: [row('a', 'm-a'), row('b', 'm-b', 'them')],
        epoch: 0,
        anchoredToPresent: true,
      });
    });
    act(() => {
      view.rerender({ items: [sending('n1')], epoch: 1, anchoredToPresent: true });
    });
    act(flush);
    expect(pin.isStuck).toBe(false);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('leaves a list detached from the present alone (the composer jumps there first)', () => {
    const { pin, scrollToBottom, view } = setup([row('a', 'm-a')]);
    act(() => {
      view.rerender({
        items: [row('a', 'm-a'), sending('n1')],
        epoch: 0,
        anchoredToPresent: false,
      });
    });
    act(flush);
    expect(pin.isStuck).toBe(false);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('does not scroll again when the pending row settles into the sent message', () => {
    const { scrollToBottom, view } = setup([row('a', 'm-a')]);
    act(() => {
      view.rerender({
        items: [row('a', 'm-a'), sending('n1')],
        epoch: 0,
        anchoredToPresent: true,
      });
    });
    act(flush);
    // Same key (the nonce), now with its real id.
    act(() => {
      view.rerender({
        items: [row('a', 'm-a'), row('n1', 'm-n1')],
        epoch: 0,
        anchoredToPresent: true,
      });
    });
    act(flush);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });
});
