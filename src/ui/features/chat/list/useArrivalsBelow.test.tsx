import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pendingMessageId, type RenderItem } from '@/core/domain';
import { arrivedBelow, useArrivalsBelow } from './useArrivalsBelow';

const row = (key: string, authorId = 'them', id = `m-${key}`): RenderItem => ({
  type: 'message',
  key,
  id: id as never,
  authorId,
  continuation: false,
});
const base = { selfId: 'me', anchoredToPresent: true, readerAtBottom: false };

describe('arrivedBelow', () => {
  const was = { epoch: 0, items: [row('a'), row('b')] };
  it("is someone else's message appended while the reader is scrolled up", () => {
    expect(arrivedBelow(was, { ...base, epoch: 0, items: [...was.items, row('c')] })).toBe(true);
  });
  it('is not a message while the reader is at the bottom (the list follows it)', () => {
    const next = { ...base, epoch: 0, items: [...was.items, row('c')], readerAtBottom: true };
    expect(arrivedBelow(was, next)).toBe(false);
  });
  it("is not the user's own send, pending or echoed back", () => {
    const pending = row('n1', 'me', pendingMessageId('n1'));
    expect(arrivedBelow(was, { ...base, epoch: 0, items: [...was.items, pending] })).toBe(false);
    expect(arrivedBelow(was, { ...base, epoch: 0, items: [...was.items, row('c', 'me')] })).toBe(
      false,
    );
  });
  it('is not a list being opened or replaced', () => {
    const items = [...was.items, row('c')];
    expect(arrivedBelow(null, { ...base, epoch: 0, items })).toBe(false);
    expect(arrivedBelow({ epoch: 0, items: [] }, { ...base, epoch: 0, items })).toBe(false);
    expect(arrivedBelow(was, { ...base, epoch: 1, items })).toBe(false);
  });
  it('is not a window detached from the present, nor a message removed from the end', () => {
    const items = [...was.items, row('c')];
    expect(arrivedBelow(was, { ...base, epoch: 0, items, anchoredToPresent: false })).toBe(false);
    expect(arrivedBelow({ epoch: 0, items }, { ...base, epoch: 0, items: was.items })).toBe(false);
  });
});

describe('useArrivalsBelow', () => {
  type Props = { items: RenderItem[]; epoch: number; atBottom: boolean };
  function setup(readerAtBottom: () => boolean) {
    return renderHook(
      (p: Props) =>
        useArrivalsBelow({ ...p, anchoredToPresent: true, selfId: 'me', readerAtBottom }),
      { initialProps: { items: [row('a'), row('b')], epoch: 0, atBottom: false } },
    );
  }

  it('shows after a message arrives below a scrolled-up reader, and hides on reaching the bottom', () => {
    const view = setup(() => false);
    expect(view.result.current.below).toBe(false);
    view.rerender({ items: [row('a'), row('b'), row('c')], epoch: 0, atBottom: false });
    expect(view.result.current.below).toBe(true);
    view.rerender({ items: [row('a'), row('b'), row('c')], epoch: 0, atBottom: true });
    expect(view.result.current.below).toBe(false);
  });

  it('never shows while the reader is at the bottom', () => {
    const view = setup(() => true);
    view.rerender({ items: [row('a'), row('b'), row('c')], epoch: 0, atBottom: true });
    expect(view.result.current.below).toBe(false);
  });

  it('hides on a jump and when the list is replaced', () => {
    const view = setup(() => false);
    view.rerender({ items: [row('a'), row('b'), row('c')], epoch: 0, atBottom: false });
    act(() => {
      view.result.current.clear();
    });
    expect(view.result.current.below).toBe(false);
    view.rerender({ items: [row('a'), row('b'), row('c'), row('d')], epoch: 0, atBottom: false });
    expect(view.result.current.below).toBe(true);
    view.rerender({ items: [row('x')], epoch: 1, atBottom: false });
    expect(view.result.current.below).toBe(false);
  });
});
