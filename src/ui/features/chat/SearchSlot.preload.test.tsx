import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePreloadSearchPanel } from './SearchSlot';

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock('./header/SearchPanel', () => {
  loaded.count += 1;
  return { SearchPanel: () => null };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  loaded.count = 0;
});

function Host() {
  usePreloadSearchPanel();
  return null;
}

describe('the search panel chunk', () => {
  it('is requested when the app is idle, not before, so the first Ctrl+F opens the panel at once', async () => {
    let idle: (() => void) | undefined;
    vi.stubGlobal('requestIdleCallback', (fn: () => void) => {
      idle = fn;
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', () => undefined);
    // `window` is the global here: the hook reads it from there.
    Object.defineProperty(window, 'requestIdleCallback', {
      value: globalThis.requestIdleCallback,
      configurable: true,
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      value: globalThis.cancelIdleCallback,
      configurable: true,
    });
    render(<Host />);
    expect(idle).toBeTypeOf('function');
    expect(loaded.count).toBe(0);
    await act(async () => {
      idle?.();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(loaded.count).toBe(1);
  });
});
