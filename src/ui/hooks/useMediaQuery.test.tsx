import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { belowBreakpoint, sharedQueryCount, useMediaQuery } from './useMediaQuery';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia() {
  const listeners = new Set<() => void>();
  let matches = false;
  const list = {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn)),
  };
  const matchMedia = vi.fn(() => list);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    list,
    set: (value: boolean) => {
      matches = value;
      for (const fn of [...listeners]) fn();
    },
  };
}

function Probe({ query, out }: { query: string; out: boolean[] }) {
  out.push(useMediaQuery(query));
  return null;
}

describe('useMediaQuery', () => {
  it('keeps nothing cached for a render that never subscribes', () => {
    stubMatchMedia();
    const never = new Promise<void>(() => undefined);
    function Suspends(): null {
      useMediaQuery('(abandoned)');
      // Suspends after reading: the render is thrown away before any subscription.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- suspending is throwing a promise
      throw never;
    }
    render(
      <Suspense fallback={null}>
        <Suspends />
      </Suspense>,
    );
    expect(sharedQueryCount()).toBe(0);
  });

  it('shares one query list and one listener between every component asking', () => {
    const media = stubMatchMedia();
    const seen: boolean[] = [];
    const rows = () => (
      <>
        {Array.from({ length: 50 }, (_, i) => (
          <Probe key={i} query="(pointer: coarse)" out={seen} />
        ))}
      </>
    );
    const many = render(rows());
    // Once subscribed, asking again (every render does) costs no new query list.
    media.matchMedia.mockClear();
    many.rerender(rows());
    expect(media.matchMedia).not.toHaveBeenCalled();
    expect(media.list.addEventListener).toHaveBeenCalledTimes(1);
    many.unmount();
    expect(media.list.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('follows changes, for all of them', () => {
    const media = stubMatchMedia();
    const a: boolean[] = [];
    const b: boolean[] = [];
    render(
      <>
        <Probe query="(max-width: 100px)" out={a} />
        <Probe query="(max-width: 100px)" out={b} />
      </>,
    );
    expect([a.at(-1), b.at(-1)]).toEqual([false, false]);
    act(() => {
      media.set(true);
    });
    expect([a.at(-1), b.at(-1)]).toEqual([true, true]);
  });

  it('does not resubscribe when it re-renders', () => {
    const media = stubMatchMedia();
    const out: boolean[] = [];
    const view = render(<Probe query="(x)" out={out} />);
    view.rerender(<Probe query="(x)" out={out} />);
    view.rerender(<Probe query="(x)" out={out} />);
    expect(media.list.addEventListener).toHaveBeenCalledTimes(1);
    expect(media.list.removeEventListener).not.toHaveBeenCalled();
  });
});

describe('belowBreakpoint', () => {
  it('is the layout limit in window px: unchanged at 100%, scaled by the zoom otherwise', () => {
    expect(belowBreakpoint('drawer')).toBe('(max-width: 759.98px)');
    expect(belowBreakpoint('members', 1)).toBe('(max-width: 1099.98px)');
    expect(belowBreakpoint('drawer', 1.5)).toBe('(max-width: 1139.97px)');
    expect(belowBreakpoint('members', 0.8)).toBe('(max-width: 879.98px)');
  });
});
