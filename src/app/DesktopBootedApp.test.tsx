/**
 * `DesktopBootedApp`'s half of the close handshake (task 3,
 * docs/ENCRYPTION.md, "Close handshake"): it registers a flusher with
 * `StorageGate` via `registerFlusher`, and that flusher flushes the
 * `Snowdrop` instance's debounced writes, then waits for the hydrated
 * storage's queued encrypted writes to actually land.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateKeyValue, MemoryMessageRepository, plaintextCipher } from '@/core/persistence';
import { DesktopBootedApp } from './DesktopBootedApp';

afterEach(cleanup);

describe('DesktopBootedApp: close handshake', () => {
  it('registers a flusher that flushes the snowdrop instance and awaits the hydrated storage', async () => {
    const storage = await hydrateKeyValue(plaintextCipher());
    const repository = new MemoryMessageRepository();
    const registerFlusher = vi.fn();

    const { unmount } = render(
      <DesktopBootedApp
        storage={storage}
        repository={repository}
        registerFlusher={registerFlusher}
      />,
    );

    expect(registerFlusher).toHaveBeenCalledTimes(1);
    const [flusher] = registerFlusher.mock.calls[0] as [() => Promise<void>];

    const flushSpy = vi.spyOn(storage, 'flush');
    await flusher();
    expect(flushSpy).toHaveBeenCalled();

    unmount();
  });

  it('does nothing (and never throws) when no registerFlusher is passed', async () => {
    const storage = await hydrateKeyValue(plaintextCipher());
    const repository = new MemoryMessageRepository();

    expect(() => {
      render(<DesktopBootedApp storage={storage} repository={repository} />);
    }).not.toThrow();
  });
});
