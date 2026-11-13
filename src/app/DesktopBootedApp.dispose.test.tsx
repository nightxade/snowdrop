/** `DesktopBootedApp` disposes the instance it builds, including under React StrictMode's double mount. */
import { StrictMode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateKeyValue, MemoryMessageRepository, plaintextCipher } from '@/core/persistence';
import { addLogSink } from '@/core/lib';
import type { Snowdrop, SnowdropOptions } from './createSnowdrop';

const made = vi.hoisted(() => ({
  disposed: [] as boolean[],
  gate: null as Promise<void> | null,
}));

vi.mock('./createSnowdrop', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const create = actual.createSnowdrop as (options?: SnowdropOptions) => Snowdrop;
  return {
    ...actual,
    createSnowdrop: (options?: SnowdropOptions) => {
      const snowdrop = create(options);
      const index = made.disposed.push(false) - 1;
      const dispose = snowdrop.dispose.bind(snowdrop);
      snowdrop.dispose = () => {
        made.disposed[index] = true;
        return (made.gate ?? Promise.resolve()).then(dispose);
      };
      return snowdrop;
    },
  };
});

const { DesktopBootedApp } = await import('./DesktopBootedApp');

afterEach(() => {
  cleanup();
  made.disposed.length = 0;
  made.gate = null;
});

async function props() {
  return {
    storage: await hydrateKeyValue(plaintextCipher()),
    repository: new MemoryMessageRepository(),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const disposedCount = () => made.disposed.filter(Boolean).length;

describe('DesktopBootedApp: disposal', () => {
  it('disposes its instance on unmount', async () => {
    const { unmount } = render(<DesktopBootedApp {...await props()} />);
    await tick();
    expect(disposedCount()).toBe(0);
    unmount();
    await tick();
    expect(disposedCount()).toBe(1);
    await vi.dynamicImportSettled();
  });

  it('under StrictMode, the double mount does not dispose the live instance, and unmount does', async () => {
    const { unmount } = render(
      <StrictMode>
        <DesktopBootedApp {...await props()} />
      </StrictMode>,
    );
    await tick();
    expect(disposedCount()).toBe(0);
    unmount();
    await tick();
    expect(disposedCount()).toBe(1);
    await vi.dynamicImportSettled();
  });

  it('a new mount waits for the previous instance to finish disposing before it starts', async () => {
    let release: () => void = () => undefined;
    made.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shared = await props();
    const first = render(<DesktopBootedApp {...shared} />);
    first.unmount();
    const flusher = vi.fn();
    render(<DesktopBootedApp {...shared} registerFlusher={flusher} />);
    await tick();
    expect(disposedCount()).toBe(1);
    expect(flusher).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => {
      expect(flusher).toHaveBeenCalledTimes(1);
    });
    await vi.dynamicImportSettled();
  });

  it('a new mount starts anyway, and reports it, when the previous disposal never settles', async () => {
    vi.useFakeTimers();
    try {
      const reported = vi.fn();
      const remove = addLogSink({ write: reported });
      made.gate = new Promise<void>(() => undefined);
      const shared = await props();
      const first = render(<DesktopBootedApp {...shared} />);
      first.unmount();
      const flusher = vi.fn();
      render(<DesktopBootedApp {...shared} registerFlusher={flusher} />);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(flusher).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(flusher).toHaveBeenCalledTimes(1);
      });
      expect(reported).toHaveBeenCalledWith(
        'error',
        'app',
        expect.stringContaining('starting anyway'),
      );
      remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
