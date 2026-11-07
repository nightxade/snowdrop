import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { createStores } from '@/core/stores';
import { makeMessage } from '@/core/domain/testing';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { TooltipProvider } from '@/ui/primitives';
import { MessageMeta } from './MessageMeta';

const clock = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/useMinuteClock', () => ({
  useMinuteClock: () => {
    clock.calls++;
    return Date.UTC(2026, 8, 30, 15, 30);
  },
}));

afterEach(() => {
  cleanup();
  clock.calls = 0;
});

function show(
  variant: 'header' | 'gutter' | 'compact',
  partial: Parameters<typeof makeMessage>[0] = {},
) {
  const stores = createStores();
  stores.session.setState({ self: { id: 'me', name: 'Me' } } as never);
  const app = { stores } as unknown as AppServices;
  return render(
    <SnowdropContextProvider value={app}>
      <TooltipProvider>
        <MessageMeta
          message={makeMessage({ authorId: 'me', status: 'delivered', ...partial })}
          variant={variant}
        />
      </TooltipProvider>
    </SnowdropContextProvider>,
  );
}

describe('<MessageMeta />', () => {
  it('only the header time follows the minute clock', () => {
    show('gutter');
    show('compact');
    expect(clock.calls).toBe(0);
    show('header');
    expect(clock.calls).toBeGreaterThan(0);
  });

  it('a disappearing countdown follows the clock, a read-timer one does not', () => {
    show('header', { expiresAfterReadMs: 60_000 });
    const timerOnly = clock.calls;
    clock.calls = 0;
    show('header', { expiresAt: Date.UTC(2026, 8, 30, 16, 0) });
    expect(clock.calls).toBeGreaterThan(timerOnly);
  });

  it('names the delivery mark as an image, with no axe violations on any mark', async () => {
    const { container, getAllByRole } = show('header', {
      pinned: true,
      expiresAt: Date.UTC(2026, 8, 30, 16, 0),
    });
    expect(getAllByRole('img').map((e) => e.getAttribute('aria-label'))).toEqual([
      'Delivered',
      'Disappearing message',
      'Pinned',
    ]);
    expect((await axe(container)).violations.map((v) => v.id)).toEqual([]);
  });
});
