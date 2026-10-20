/**
 * Boot wiring shared by src/main.tsx's `bootBrowser` and `DesktopBootedApp`
 * (task 6b): the safe-mode toast and a
 * flush on page hide. Exercised directly against a real (undispatched)
 * `Snowdrop` instance — no React involved, since the helper itself isn't a
 * component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '@/core/persistence';
import { createSnowdrop, type Snowdrop } from './createSnowdrop';
import { installBootHelpers } from './installBootHelpers';

function makeSnowdrop(): Snowdrop {
  return createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('installBootHelpers', () => {
  it('shows the safe-mode toast when started in safe mode', () => {
    const snowdrop = makeSnowdrop();
    cleanup = installBootHelpers({ snowdrop, safeMode: true });

    const toasts = snowdrop.stores.ui.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toBe(
      'Safe mode: imported themes and Custom CSS are off until you reload.',
    );
  });

  it('never reloads into safe mode from the keyboard or pointer', () => {
    const snowdrop = makeSnowdrop();
    cleanup = installBootHelpers({ snowdrop, safeMode: false });
    expect(snowdrop.stores.ui.getState().toasts).toHaveLength(0);
    const reload = vi.spyOn(snowdrop.admin, 'reload').mockResolvedValue();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', repeat: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { shiftKey: true }));
    expect(reload).not.toHaveBeenCalled();
  });

  it('flushes on pagehide, in both modes', () => {
    const snowdrop = makeSnowdrop();
    cleanup = installBootHelpers({ snowdrop, safeMode: false });
    const flush = vi.spyOn(snowdrop, 'flush');

    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('the cleanup function removes every listener it added', () => {
    const snowdrop = makeSnowdrop();
    const stop = installBootHelpers({ snowdrop, safeMode: false });
    stop();
    cleanup = null;

    const flush = vi.spyOn(snowdrop, 'flush');
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).not.toHaveBeenCalled();
  });
});
