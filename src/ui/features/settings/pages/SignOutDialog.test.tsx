/**
 * "Sign out of Signal on this computer?" — the desktop flow. A fake
 * `AppServices` stands in for a real `Snowdrop` (in the style of
 * DemoBanner.test.tsx's `fakeApp`); `signOutFlowFor` picks the desktop flow
 * whenever `backend.kind === 'signal-cli'` and `storageAdmin` is set.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { SignOutDialog } from './SignOutDialog';

afterEach(cleanup);

function fakeApp(overrides: {
  clearHistory?: ReturnType<typeof vi.fn>;
  persist?: ReturnType<typeof vi.fn>;
  setPendingHistoryClear?: ReturnType<typeof vi.fn>;
  signOut?: ReturnType<typeof vi.fn>;
  restart?: ReturnType<typeof vi.fn>;
}): AppServices {
  const update = vi.fn();
  const clearHistory = overrides.clearHistory ?? vi.fn(() => Promise.resolve());
  const persist = overrides.persist ?? vi.fn(() => Promise.resolve());
  const setPendingHistoryClear = overrides.setPendingHistoryClear ?? vi.fn(() => Promise.resolve());
  const signOut = overrides.signOut ?? vi.fn(() => Promise.resolve());
  const restart = overrides.restart ?? vi.fn(() => Promise.resolve());
  return {
    backend: { kind: 'signal-cli' },
    stores: {
      settings: { getState: () => ({ update }) },
      session: createStore(() => ({ self: null })),
    },
    admin: { clearHistory, persist, setPendingHistoryClear },
    storageAdmin: { signOut, restart },
  } as unknown as AppServices;
}

describe('SignOutDialog: desktop sign-out', () => {
  it('signs out normally when every step succeeds', async () => {
    const restart = vi.fn(() => Promise.resolve());
    const app = fakeApp({ restart });
    render(
      <SnowdropContextProvider value={app}>
        <SignOutDialog onClose={vi.fn()} />
      </SnowdropContextProvider>,
    );
    expect(await screen.findByText('Sign out of Signal on this computer?')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    await waitFor(() => {
      expect(restart).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('Restart Snowdrop to finish')).toBeNull();
  });

  it('shows an explicit restart retry, never re-offering Sign out, if the final restart fails', async () => {
    const restart = vi
      .fn()
      .mockRejectedValueOnce(new Error('IPC timed out'))
      .mockResolvedValue(undefined);
    const app = fakeApp({ restart });
    render(
      <SnowdropContextProvider value={app}>
        <SignOutDialog onClose={vi.fn()} />
      </SnowdropContextProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });

    expect(await screen.findByText('Restart Snowdrop to finish')).toBeTruthy();
    // The account is already signed out on this computer: never offer to
    // run the whole flow again.
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText(/close Snowdrop and reopen it yourself/u)).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart Snowdrop' }));
    });
    await waitFor(() => {
      expect(restart).toHaveBeenCalledTimes(2);
    });
  });

  it('records a pending-clear flag, but still restarts, if clearHistory fails', async () => {
    const clearHistory = vi.fn(() => Promise.reject(new Error('IDB is busy')));
    const setPendingHistoryClear = vi.fn(() => Promise.resolve());
    const restart = vi.fn(() => Promise.resolve());
    const app = fakeApp({ clearHistory, setPendingHistoryClear, restart });
    render(
      <SnowdropContextProvider value={app}>
        <SignOutDialog onClose={vi.fn()} />
      </SnowdropContextProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    await waitFor(() => {
      expect(restart).toHaveBeenCalledTimes(1);
    });
    expect(setPendingHistoryClear).toHaveBeenCalledWith(true);
  });
});
