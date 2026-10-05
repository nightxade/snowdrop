/**
 * The demo banner (PLAN §4.10): shown only while the mock backend is
 * running, and its button leaves the demo directly — no confirm dialog,
 * since clicking it is already the explicit intent.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { DemoBanner } from './DemoBanner';

afterEach(cleanup);

function fakeApp(
  kind: 'mock' | 'signal-cli',
  options: { update?: ReturnType<typeof vi.fn>; reload?: ReturnType<typeof vi.fn> } = {},
): AppServices {
  const update = options.update ?? vi.fn();
  const reload = options.reload ?? vi.fn(() => Promise.resolve());
  return {
    backend: { kind },
    stores: { settings: { getState: () => ({ update }) } },
    admin: { reload },
  } as unknown as AppServices;
}

describe('DemoBanner', () => {
  it('shows the demo notice while the mock backend is running', () => {
    render(
      <SnowdropContextProvider value={fakeApp('mock')}>
        <DemoBanner />
      </SnowdropContextProvider>,
    );
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain("You're exploring the demo — nothing here is real.");
    expect(screen.getByRole('button', { name: 'Use your Signal account' })).toBeTruthy();
  });

  it('renders nothing once a real backend is running', () => {
    render(
      <SnowdropContextProvider value={fakeApp('signal-cli')}>
        <DemoBanner />
      </SnowdropContextProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use your Signal account' })).toBeNull();
  });

  it('leaves the demo directly on click: backend cleared, then reload — no dialog', async () => {
    const order: string[] = [];
    const update = vi.fn(() => {
      order.push('update');
    });
    const reload = vi.fn(() => {
      order.push('reload');
      return Promise.resolve();
    });
    render(
      <SnowdropContextProvider value={fakeApp('mock', { update, reload })}>
        <DemoBanner />
      </SnowdropContextProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Use your Signal account' }));
    });
    // leaveDemo is loaded on demand (a dynamic import), so give it a tick.
    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
    });

    expect(update).toHaveBeenCalledWith('connection', { backend: null });
    expect(order).toEqual(['update', 'reload']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
