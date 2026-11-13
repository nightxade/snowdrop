import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageId, type MessageId, type RenderItem } from '@/core/domain';
import { RowState } from './rowState';
import { useJumpTarget } from './useJumpTarget';
import { useUnreadDivider } from './useUnreadDivider';

const idA = messageId('alice', 1);
const idB = messageId('alice', 2);

function messageItem(id: MessageId): RenderItem {
  return { type: 'message', id, key: id, continuation: false } as unknown as RenderItem;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useJumpTarget', () => {
  function setup(rows = new RowState()) {
    const items = [messageItem(idA), messageItem(idB)];
    const virtuoso = { current: { scrollToIndex: vi.fn() } };
    const scroller = { current: document.createElement('div') };
    const hook = renderHook(() =>
      useJumpTarget({
        items,
        virtuoso: virtuoso as never,
        scroller,
        rows,
        reducedMotion: () => true,
      }),
    );
    return { hook, rows, virtuoso };
  }

  it('releases the flash timer when the list unmounts', () => {
    const { hook, rows } = setup();
    act(() => {
      hook.result.current.setTarget({ id: idA, flash: true, focus: false });
    });
    act(() => {
      vi.advanceTimersByTime(50); // the animation frame runs and starts the flash
    });
    expect(rows.isFlashing(idA)).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a stale request clear nothing once a newer target is set', () => {
    const { hook, virtuoso } = setup();
    let first = 0;
    act(() => {
      first = hook.result.current.setTarget({ id: idA, flash: false, focus: false });
    });
    act(() => {
      hook.result.current.setTarget({ id: idB, flash: false, focus: false });
    });
    act(() => {
      hook.result.current.clearTarget(first); // the first reveal failed late
    });
    expect(hook.result.current.target?.id).toBe(idB);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(virtuoso.current.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuoso.current.scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1 }),
    );
  });

  it('clears the target for the latest request', () => {
    const { hook } = setup();
    let token = 0;
    act(() => {
      token = hook.result.current.setTarget({ id: idA, flash: false, focus: false });
    });
    act(() => {
      hook.result.current.clearTarget(token);
    });
    expect(hook.result.current.target).toBeNull();
  });
});

describe('useUnreadDivider', () => {
  it('measures at most once per frame however many scroll events arrive', () => {
    const el = document.createElement('div');
    const divider = document.createElement('div');
    divider.setAttribute('data-snowdrop', 'new-divider');
    el.append(divider);
    const query = vi.spyOn(el, 'querySelector');
    const items = [
      messageItem(idA),
      { type: 'new-divider', key: 'new' } as unknown as RenderItem,
      messageItem(idB),
    ];
    const { result } = renderHook(() => useUnreadDivider({ items, scroller: { current: el } }));
    expect(result.current.dividerIndex).toBe(1);
    act(() => {
      for (let i = 0; i < 20; i++) result.current.scheduleMeasure();
    });
    expect(query).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(query).toHaveBeenCalledTimes(1);
    // Next frame, a new scroll burst measures again.
    act(() => {
      result.current.scheduleMeasure();
      result.current.scheduleMeasure();
      vi.advanceTimersByTime(50);
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reports a divider above the rendered range when its row is not mounted', () => {
    const items = [
      messageItem(idA),
      { type: 'new-divider', key: 'new' } as unknown as RenderItem,
      messageItem(idB),
    ];
    const { result } = renderHook(() =>
      useUnreadDivider({ items, scroller: { current: document.createElement('div') } }),
    );
    expect(result.current.dividerPos).toBe('below');
    act(() => {
      result.current.rangeChanged(2);
    });
    expect(result.current.dividerPos).toBe('above');
  });
});
