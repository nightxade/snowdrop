import { describe, expect, it } from 'vitest';
import { ManualScheduler, type Cancel, type Scheduler } from '@/core/lib';
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

  describe('strict runs', () => {
    it('have no quiet period: only finish() or the ceiling ends them', () => {
      const { tracker, scheduler } = setup({ quietMs: 1_500, ceilingMs: 20_000 });
      tracker.start(undefined, { strict: true });
      expect(tracker.isStrict).toBe(true);
      tracker.armQuiet();
      scheduler.advance(5_000);
      tracker.onMessage();
      scheduler.advance(10_000);
      expect(tracker.isCatchingUp).toBe(true);
      tracker.finish();
      expect(tracker.isCatchingUp).toBe(false);
      expect(tracker.isStrict).toBe(false);
    });

    it('end by the ceiling, and a plain start() afterwards is not strict', () => {
      const { tracker, scheduler } = setup({ ceilingMs: 20_000 });
      tracker.start(undefined, { strict: true });
      scheduler.advance(20_000);
      expect(tracker.isCatchingUp).toBe(false);
      tracker.start();
      expect(tracker.isStrict).toBe(false);
      tracker.armQuiet();
      scheduler.advance(1_500);
      expect(tracker.isCatchingUp).toBe(false);
    });
  });

  describe('diagnostics callbacks', () => {
    function withCallbacks() {
      const scheduler = new ManualScheduler(0);
      const events: unknown[] = [];
      const tracker = new CatchUpTracker({
        clock: scheduler,
        scheduler,
        onChange: () => undefined,
        onStart: (info) => events.push(['start', info]),
        onEnd: (reason, info) => events.push(['end', reason, info]),
      });
      return { scheduler, events, tracker };
    }

    it('report the reason each run ended, with a count of messages and nothing else', () => {
      const { tracker, scheduler, events } = withCallbacks();
      tracker.start();
      tracker.armQuiet();
      tracker.onMessage();
      scheduler.advance(1_500);
      tracker.start(undefined, { strict: true });
      tracker.onMessage();
      tracker.onMessage();
      tracker.finish();
      tracker.start();
      scheduler.advance(20_000);
      expect(events).toEqual([
        ['start', { strict: false, restarted: false }],
        ['end', 'quiet', { strict: false, messages: 1 }],
        ['start', { strict: true, restarted: false }],
        ['end', 'caughtUp', { strict: true, messages: 2 }],
        ['start', { strict: false, restarted: false }],
        ['end', 'ceiling', { strict: false, messages: 0 }],
      ]);
    });

    it('report a restart, and nothing for finish() with no run or for dispose()', () => {
      const { tracker, events } = withCallbacks();
      tracker.finish();
      tracker.start();
      tracker.start();
      tracker.dispose();
      expect(events).toEqual([
        ['start', { strict: false, restarted: false }],
        ['start', { strict: false, restarted: true }],
      ]);
    });
  });

  describe('timers that run late', () => {
    /** A scheduler whose cancel does nothing and that runs callbacks only when told: a due timer that was already queued. */
    function lateScheduler() {
      const pending: (() => void)[] = [];
      const scheduler: Scheduler = {
        setTimeout(fn): Cancel {
          pending.push(fn);
          return () => undefined;
        },
      };
      return { scheduler, pending };
    }

    it('a ceiling from before a sleep, run late, does not end a run started after the wake', () => {
      const { scheduler, pending } = lateScheduler();
      const changes: boolean[] = [];
      const tracker = new CatchUpTracker({
        clock: { now: () => 0 },
        scheduler,
        onChange: (v) => changes.push(v),
      });
      tracker.start(120_000, { strict: true });
      const beforeSleep = pending[0]!;
      // Wake: the new connection restarts the run before the old timer gets to run.
      tracker.start(120_000, { strict: true });
      const afterWake = pending[1]!;
      beforeSleep();
      expect(tracker.isCatchingUp).toBe(true);
      expect(changes).toEqual([true]);
      afterWake();
      expect(tracker.isCatchingUp).toBe(false);
    });

    it('a quiet timer from an earlier run, run late, does not end the next one', () => {
      const { scheduler, pending } = lateScheduler();
      const tracker = new CatchUpTracker({
        clock: { now: () => 0 },
        scheduler,
        onChange: () => undefined,
      });
      tracker.start();
      tracker.armQuiet();
      const staleQuiet = pending[1]!;
      tracker.start();
      tracker.armQuiet();
      staleQuiet();
      expect(tracker.isCatchingUp).toBe(true);
      pending[3]!();
      expect(tracker.isCatchingUp).toBe(false);
    });

    it('a timer of a run that already ended does nothing', () => {
      const { scheduler, pending } = lateScheduler();
      const tracker = new CatchUpTracker({
        clock: { now: () => 0 },
        scheduler,
        onChange: () => undefined,
      });
      tracker.start();
      tracker.finish();
      tracker.start();
      pending[0]!();
      expect(tracker.isCatchingUp).toBe(true);
    });
  });
});
