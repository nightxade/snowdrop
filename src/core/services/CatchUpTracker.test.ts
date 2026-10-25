import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { CatchUpTracker } from './CatchUpTracker';

function setup(overrides: { quietMs?: number; ceilingMs?: number } = {}) {
  const scheduler = new ManualScheduler(0);
  const changes: boolean[] = [];
  const tracker = new CatchUpTracker({
    clock: scheduler,
    scheduler,
    onChange: (v) => changes.push(v),
    quietMs: overrides.quietMs ?? 1_500,
    ceilingMs: overrides.ceilingMs ?? 20_000,
  });
  return { scheduler, changes, tracker };
}

describe('CatchUpTracker', () => {
  it('starts catching up immediately', () => {
    const { tracker, changes } = setup();
    expect(tracker.isCatchingUp).toBe(false);
    tracker.start();
    expect(tracker.isCatchingUp).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('ends on the backend caught-up signal', () => {
    const { tracker, scheduler, changes } = setup();
    tracker.start();
    scheduler.advance(500);
    tracker.finish();
    expect(tracker.isCatchingUp).toBe(false);
    expect(changes).toEqual([true, false]);
    // The quiet/ceiling timers are cancelled, so nothing fires later.
    scheduler.advance(30_000);
    expect(changes).toEqual([true, false]);
  });

  it('falls back to a quiet period when the backend never reports caught-up', () => {
    const { tracker, scheduler, changes } = setup({ quietMs: 1_500 });
    tracker.start();
    tracker.armQuiet();
    scheduler.advance(1_499);
    expect(tracker.isCatchingUp).toBe(true);
    scheduler.advance(1);
    expect(tracker.isCatchingUp).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('silence before armQuiet (still connecting) does not end it', () => {
    const { tracker, scheduler, changes } = setup({ quietMs: 1_500 });
    tracker.start();
    tracker.onMessage();
    scheduler.advance(10_000);
    expect(tracker.isCatchingUp).toBe(true);
    tracker.armQuiet();
    scheduler.advance(1_500);
    expect(changes).toEqual([true, false]);
  });

  it('onMessage resets the quiet period, so a steady stream keeps it catching up', () => {
    const { tracker, scheduler, changes } = setup({ quietMs: 1_500 });
    tracker.start();
    tracker.armQuiet();
    for (let i = 0; i < 5; i++) {
      scheduler.advance(1_000);
      tracker.onMessage();
    }
    expect(tracker.isCatchingUp).toBe(true);
    expect(changes).toEqual([true]);
    // Now let it go quiet.
    scheduler.advance(1_500);
    expect(tracker.isCatchingUp).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('onMessage after it already finished does not restart catching up', () => {
    const { tracker, scheduler, changes } = setup({ quietMs: 1_500 });
    tracker.start();
    tracker.armQuiet();
    scheduler.advance(1_500);
    expect(tracker.isCatchingUp).toBe(false);
    tracker.onMessage();
    expect(tracker.isCatchingUp).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('a hard ceiling ends it even with a steady stream of messages', () => {
    const { tracker, scheduler, changes } = setup({ quietMs: 1_500, ceilingMs: 20_000 });
    tracker.start();
    tracker.armQuiet();
    // A message every 500ms, forever resetting the quiet timer, never reaching it.
    for (let i = 0; i < 50; i++) {
      scheduler.advance(500);
      tracker.onMessage();
    }
    expect(scheduler.now()).toBe(25_000);
    expect(tracker.isCatchingUp).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('a reconnect (start() called again) restarts catching up', () => {
    const { tracker, scheduler, changes } = setup({ quietMs: 1_500 });
    tracker.start();
    tracker.finish();
    expect(changes).toEqual([true, false]);
    scheduler.advance(5_000);
    tracker.start();
    tracker.armQuiet();
    expect(tracker.isCatchingUp).toBe(true);
    expect(changes).toEqual([true, false, true]);
    scheduler.advance(1_500);
    expect(tracker.isCatchingUp).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
  });

  it('dispose stops the timers without notifying', () => {
    const { tracker, scheduler, changes } = setup({ quietMs: 1_500 });
    tracker.start();
    tracker.dispose();
    expect(tracker.isCatchingUp).toBe(false);
    expect(changes).toEqual([true]);
    scheduler.advance(30_000);
    expect(changes).toEqual([true]);
  });

  it('start() can override the ceiling for one run only', () => {
    const { tracker, scheduler } = setup({ ceilingMs: 20_000 });
    tracker.start(120_000);
    scheduler.advance(119_999);
    expect(tracker.isCatchingUp).toBe(true);
    scheduler.advance(1);
    expect(tracker.isCatchingUp).toBe(false);
    tracker.start();
    scheduler.advance(20_000);
    expect(tracker.isCatchingUp).toBe(false);
  });
});
