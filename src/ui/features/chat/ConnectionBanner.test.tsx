/**
 * The connection banner shows a plain, kind-specific message on error, never
 * the raw exception text. Logging the raw detail is SyncService's job (it's
 * logged once there, at the right level); the banner itself must not also
 * log it, or a visible connection error would be logged repeatedly, once
 * per render.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/core/lib';
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
      snowdrop!.stores.session.getState().markSynced();
      snowdrop!.stores.session
        .getState()
        .markFailed(new AppError('internal', 'boom (NullPointerException)'));
    });
    await settle(snowdrop);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/signal-cli ran into an internal problem/u);
    expect(banner.textContent).not.toMatch(/NullPointerException/u);
    // The banner itself logs nothing: not here, and not from re-renders
    // while the same error stays on screen (no per-render log spam).
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('renders nothing once back online', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <ConnectionBanner />);
    act(() => {
      snowdrop!.stores.session.getState().setLink('online');
    });
    await settle(snowdrop);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offline copy promises only what happens: a failed message can be retried', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <ConnectionBanner />);
    act(() => {
      snowdrop!.stores.session.getState().markSynced();
      snowdrop!.stores.session.getState().setLink('offline');
    });
    await settle(snowdrop);
    const text = screen.getByRole('status').textContent;
    expect(text).toMatch(/can be retried once the demo backend is back/u);
    expect(text).not.toMatch(/will go out/u);
  });

  it('hands focus on, never to the page, when Retry is taken away', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(
      snowdrop,
      <>
        <ConnectionBanner />
        <textarea data-snowdrop="composer-input" aria-label="Message" />
      </>,
    );
    act(() => {
      snowdrop!.stores.session.getState().markSynced();
      snowdrop!.stores.session.getState().setLink('offline');
    });
    await settle(snowdrop);
    const retry = screen.getByRole('button', { name: /retry/iu });
    act(() => {
      retry.focus();
    });
    expect(document.activeElement).toBe(retry);
    act(() => {
      snowdrop!.stores.session.getState().setLink('connecting');
    });
    await settle(snowdrop);
    expect(screen.queryByRole('button', { name: /retry/iu })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Message'));
  });
});
