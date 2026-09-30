/**
 * Time sources are injected everywhere time matters (typing expiry, mock
 * liveliness, optimistic timestamps) so tests can drive time explicitly
 * instead of sleeping.
 */

export interface Clock {
  now(): number;
}

export type Cancel = () => void;

export interface Scheduler {
  /** Runs `fn` once after `ms`; returns a cancel function. */
  setTimeout(fn: () => void, ms: number): Cancel;
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemScheduler: Scheduler = {
  setTimeout(fn, ms) {
    const handle = globalThis.setTimeout(fn, ms);
    return () => {
      globalThis.clearTimeout(handle);
    };
  },
};

/**
 * Deterministic clock + scheduler for tests: time only moves when `advance`
 * is called, and due tasks run in timestamp order (FIFO for ties).
 */
export class ManualScheduler implements Clock, Scheduler {
  private time: number;
  private seq = 0;
  private tasks: { at: number; seq: number; fn: () => void }[] = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): Cancel {
    const task = { at: this.time + Math.max(0, ms), seq: this.seq++, fn };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((t) => t !== task);
    };
  }

  /** Advances time by `ms`, running every task that falls due (including newly scheduled ones). */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.tasks = this.tasks.filter((t) => t !== next);
      this.time = next.at;
      next.fn();
    }
    this.time = target;
  }

  /** Runs everything currently queued (and anything it schedules), up to a safety limit. */
  runAll(limit = 10_000): void {
    for (let i = 0; i < limit; i++) {
      const next = this.nextDue(Number.POSITIVE_INFINITY);
      if (!next) return;
      this.tasks = this.tasks.filter((t) => t !== next);
      this.time = Math.max(this.time, next.at);
      next.fn();
    }
    throw new Error('ManualScheduler.runAll: task limit exceeded (runaway timer loop?)');
  }

  get pending(): number {
    return this.tasks.length;
  }

  private nextDue(limit: number): { at: number; seq: number; fn: () => void } | undefined {
    let best: { at: number; seq: number; fn: () => void } | undefined;
    for (const t of this.tasks) {
      if (t.at > limit) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }
}
