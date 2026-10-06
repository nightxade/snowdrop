/**
 * The connection banner shows a plain, kind-specific message on error, never
 * the raw exception text — the raw detail only ever reaches the console.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import type { Snowdrop } from '@/app/createSnowdrop';
import { ConnectionBanner } from './ConnectionBanner';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('ConnectionBanner', () => {
  it('shows plain copy for an error kind, keeping the raw detail out of the DOM', async () => {
    snowdrop = await bootSnowdrop();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderWithSnowdrop(snowdrop, <ConnectionBanner />);

    act(() => {
      snowdrop!.stores.session.getState().setReady(true);
      snowdrop!.stores.session.getState().setError('boom (NullPointerException)', 'internal');
      snowdrop!.stores.session.getState().setStatus('error');
    });
    await settle(snowdrop);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/signal-cli ran into an internal problem/u);
    expect(banner.textContent).not.toMatch(/NullPointerException/u);
    expect(consoleError).toHaveBeenCalledWith('[ui] connection error boom (NullPointerException)');

    consoleError.mockRestore();
  });

  it('renders nothing once back online', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <ConnectionBanner />);
    act(() => {
      snowdrop!.stores.session.getState().setStatus('online');
    });
    await settle(snowdrop);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
