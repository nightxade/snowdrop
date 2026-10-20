/**
 * `installStallDetector` with `setTimeout`, `performance.now` and
 * `document.hidden` all faked, so how late a heartbeat is is just the time
 * we choose to advance between manually-driven beats (250 ms = on time).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createStores, type Stores } from '@/core/stores';
import { installStallDetector } from './perf';

describe('installStallDetector', () => {
  let stores: Stores;
  let time: number;
  let pendingBeat: (() => void) | null;
  let warnSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    stores = createStores();
    time = 0;
    pendingBeat = null;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
      pendingBeat = cb;
      return 1;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
      pendingBeat = null;
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

  /** Advances the fake clock and fires whichever beat is currently scheduled. */
  function tick(advanceMs: number): void {
    time += advanceMs;
    const cb = pendingBeat;
    pendingBeat = null;
    cb?.();
  }

  it('logs "UI stalled <ms> ms" with route context once a heartbeat is more than 500ms late', () => {
    const stop = installStallDetector(stores);
    tick(250); // an on-time beat: no warning
    tick(900); // a stall
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [line] = warnSpy.mock.calls[0] as [string];
    expect(line).toContain('UI stalled 650 ms');
    expect(line).toContain('route=space:home');
    stop();
  });

  it('rate-limits to at most one line per 5s', () => {
    const stop = installStallDetector(stores);
    tick(250);
    tick(900); // logs (1st)
    tick(900); // another stall, but inside the 5s window: suppressed
    expect(warnSpy).toHaveBeenCalledTimes(1);
    tick(5250); // well past the window, and itself a stall: logs again
    expect(warnSpy).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never logs while the document is hidden', () => {
    const stop = installStallDetector(stores);
    tick(250);
    setHidden(true);
    tick(5000); // a huge gap, but the window is backgrounded
    expect(warnSpy).not.toHaveBeenCalled();
    stop();
  });

  it('resets on resume, so a long background spell is not reported as a stall', () => {
    const stop = installStallDetector(stores);
    tick(250);
    setHidden(true);
    // The window was backgrounded for a while; timers are throttled while
    // hidden, so no `tick()` happens during this gap.
    time += 10_000;
    setHidden(false); // resume: the visibilitychange listener resets the baseline
    tick(250); // the next beat, on time
    expect(warnSpy).not.toHaveBeenCalled();
    stop();
  });

  it('stops scheduling further beats once disposed', () => {
    const stop = installStallDetector(stores);
    tick(250);
    const scheduled = pendingBeat;
    stop();
    expect(pendingBeat).toBeNull();
    // Even if a beat Snowdrop already scheduled still fires (a race with
    // dispose), the detector must not act on it.
    time += 5000;
    scheduled?.();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
