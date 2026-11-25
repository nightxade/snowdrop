import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useContainedWheel } from './useContainedWheel';

function Panel() {
  const ref = useContainedWheel();
  return (
    <div ref={ref} data-testid="panel">
      <div data-testid="list" style={{ overflowY: 'auto' }}>
        <span data-testid="row">row</span>
      </div>
      <p data-testid="static">text</p>
    </div>
  );
}

/** happy-dom has no layout: give the list a scroll range, clamped as a browser's is. */
function sizeList(list: HTMLElement, scrollHeight: number, clientHeight: number) {
  let top = 0;
  Object.defineProperty(list, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.min(Math.max(v, 0), scrollHeight - clientHeight);
    },
    configurable: true,
  });
  Object.defineProperty(list, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: clientHeight, configurable: true });
}

function wheel(target: Element, init: WheelEventInit) {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  // happy-dom drops the modifier from the init: set it the way a real event reports it.
  if (init.ctrlKey) Object.defineProperty(e, 'ctrlKey', { value: true });
  target.dispatchEvent(e);
  return e;
}

afterEach(cleanup);

describe('useContainedWheel', () => {
  it('scrolls the area under the pointer and stops the event', () => {
    const { getByTestId } = render(<Panel />);
    const list = getByTestId('list');
    sizeList(list, 1000, 200);
    const e = wheel(getByTestId('row'), { deltaY: 120 });
    expect(list.scrollTop).toBe(120);
    expect(e.defaultPrevented).toBe(true);
  });

  it('scrolls up, and keeps the event at the edge', () => {
    const { getByTestId } = render(<Panel />);
    const list = getByTestId('list');
    sizeList(list, 1000, 200);
    list.scrollTop = 50;
    expect(wheel(getByTestId('row'), { deltaY: -30 }).defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(20);
    list.scrollTop = 0;
    expect(wheel(getByTestId('row'), { deltaY: -30 }).defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(0);
  });

  it('reads line and page deltas', () => {
    const { getByTestId } = render(<Panel />);
    const list = getByTestId('list');
    sizeList(list, 1000, 200);
    wheel(getByTestId('row'), { deltaY: 2, deltaMode: 2 });
    expect(list.scrollTop).toBe(400);
    list.scrollTop = 0;
    wheel(getByTestId('row'), { deltaY: 3, deltaMode: 1 });
    expect(list.scrollTop).toBe(48);
  });

  it('still contains a wheel over a part with nothing to scroll', () => {
    const { getByTestId } = render(<Panel />);
    sizeList(getByTestId('list'), 100, 200);
    expect(wheel(getByTestId('static'), { deltaY: 40 }).defaultPrevented).toBe(true);
  });

  it('leaves pinch zoom and sideways gestures alone', () => {
    const { getByTestId } = render(<Panel />);
    const list = getByTestId('list');
    sizeList(list, 1000, 200);
    expect(wheel(getByTestId('row'), { deltaY: 40, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(getByTestId('row'), { deltaX: 60, deltaY: 10 }).defaultPrevented).toBe(false);
    expect(list.scrollTop).toBe(0);
  });

  it('stops listening when the element goes', () => {
    const { getByTestId, unmount } = render(<Panel />);
    const panel = getByTestId('panel');
    unmount();
    expect(wheel(panel, { deltaY: 40 }).defaultPrevented).toBe(false);
  });
});
