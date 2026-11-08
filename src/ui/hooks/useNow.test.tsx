import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './useNow';

function Clock({ interval }: { interval?: number }) {
  const now = useNow(interval);
  return <output>{now}</output>;
}

const shown = () => Number(screen.getByRole('status').textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useNow', () => {
  it('ticks on its interval', () => {
    render(<Clock interval={60_000} />);
    expect(shown()).toBe(1_000_000);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shown()).toBe(1_060_000);
  });

  it('catches up when the window is shown again after it slept', () => {
    render(<Clock interval={61_000} />);
    // The machine slept: the clock moved on without the interval having fired.
    vi.setSystemTime(1_000_000 + 3_600_000);
    expect(shown()).toBe(1_000_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(shown()).toBe(1_000_000 + 3_600_000);
  });

  it('catches up when the window gets focus', () => {
    render(<Clock interval={62_000} />);
    vi.setSystemTime(1_000_000 + 600_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(shown()).toBe(1_000_000 + 600_000);
  });

  it('does not refresh while the page is hidden, and stops listening on unmount', () => {
    const view = render(<Clock interval={63_000} />);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.setSystemTime(2_000_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(shown()).toBe(1_000_000);
    const remove = vi.spyOn(document, 'removeEventListener');
    view.unmount();
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
