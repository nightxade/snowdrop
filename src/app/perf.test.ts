/**
 * `installStallDetector` with `requestAnimationFrame`, `performance.now`
 * and `document.hidden` all faked, so a frame "gap" is just the time we
 * choose to advance between manually-driven ticks.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createStores, type Stores } from '@/core/stores';
import { installStallDetector } from './perf';

describe('installStallDetector', () => {
  let stores: Stores;
  let time: number;
  let pendingFrame: (() => void) | null;
  let warnSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    stores = createStores();
    time = 0;
    pendingFrame = null;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      pendingFrame = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      pendingFrame = null;
    });
    setHidden(false);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  /** Advances the fake clock and fires whichever frame is currently scheduled. */
  function tick(advanceMs: number): void {
    time += advanceMs;
    const cb = pendingFrame;
    pendingFrame = null;
    cb?.();
  }

  it('logs "UI stalled <ms> ms" with route context once a frame gap exceeds 500ms', () => {
    const stop = installStallDetector(stores);
    tick(16); // an ordinary frame: no warning
    tick(650); // a stall
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [line] = warnSpy.mock.calls[0] as [string];
    expect(line).toContain('UI stalled 650 ms');
    expect(line).toContain('route=space:home');
    stop();
  });

  it('rate-limits to at most one line per 5s', () => {
    const stop = installStallDetector(stores);
    tick(16);
    tick(650); // logs (1st)
    tick(650); // another stall, but inside the 5s window: suppressed
    expect(warnSpy).toHaveBeenCalledTimes(1);
    tick(5000); // well past the window, and itself a stall: logs again
    expect(warnSpy).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never logs while the document is hidden', () => {
    const stop = installStallDetector(stores);
    tick(16);
    setHidden(true);
    tick(5000); // a huge gap, but the window is backgrounded
    expect(warnSpy).not.toHaveBeenCalled();
    stop();
  });

  it('resets on resume, so a long background spell is not reported as a stall', () => {
    const stop = installStallDetector(stores);
    tick(16);
    setHidden(true);
    // The window was backgrounded for a while; browsers typically suspend
    // rAF entirely while hidden, so no `tick()` happens during this gap.
    time += 10_000;
    setHidden(false); // resume: the visibilitychange listener resets the baseline
    tick(16); // the next real frame, shortly after
    expect(warnSpy).not.toHaveBeenCalled();
    stop();
  });

  it('stops scheduling further frames once disposed', () => {
    const stop = installStallDetector(stores);
    tick(16);
    const scheduled = pendingFrame;
    stop();
    expect(pendingFrame).toBeNull();
    // Even if a frame Snowdrop already asked for still fires (a race with
    // dispose), the detector must not act on it.
    time += 5000;
    scheduled?.();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
