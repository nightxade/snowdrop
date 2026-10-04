/**
 * Boot wiring shared by src/main.tsx's `bootBrowser` and `DesktopBootedApp`
 * (task 6b): the safe-mode toast or Shift-to-safe-mode listener, and a
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
  it('shows the safe-mode toast and skips the Shift listener when already in safe mode', () => {
    const snowdrop = makeSnowdrop();
    cleanup = installBootHelpers({ snowdrop, safeMode: true });

    const toasts = snowdrop.stores.ui.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toBe(
      'Safe mode: imported themes and Custom CSS are off until you reload.',
    );

    // A held Shift does nothing once already in safe mode (no listener attached).
    const flush = vi.spyOn(snowdrop, 'flush');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', repeat: true }));
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushes and reloads into ?safe=1 on a held Shift, outside safe mode', () => {
    const snowdrop = makeSnowdrop();
    cleanup = installBootHelpers({ snowdrop, safeMode: false });
    expect(snowdrop.stores.ui.getState().toasts).toHaveLength(0);

    const flush = vi.spyOn(snowdrop, 'flush');
    // A single keydown (key repeat false) is a normal keystroke, not a held Shift.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', repeat: false }));
    expect(flush).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', repeat: true }));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain('safe=1');
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
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', repeat: true }));
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).not.toHaveBeenCalled();
  });
});
