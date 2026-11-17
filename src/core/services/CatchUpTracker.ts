/**
 * Tracks whether the backend is still draining messages that arrived on the
 * server while Snowdrop was closed, so the UI can freeze the sidebar instead
 * of visibly cycling through old previews (PLAN: "catching up").
 *
 * A session is "catching up" from `start()` (initial connect, and again on
 * `start()` after a reconnect that followed an offline period — SyncService
 * decides when that applies) until whichever comes first:
 * - the backend reports it caught up with the server's queue (`finish()`,
 *   from signal-cli's `receiveCaughtUp` notification — see SignalCliBackend);
 * - a quiet period with no incoming messages, for backends that never send
 *   that signal. It only counts once `armQuiet()` says the backlog can flow
 *   (after the initial sync); `onMessage()` restarts it. A `strict` run has
 *   no quiet period at all: the backend promised its signal, and silence
 *   right after a wake (network, server, late timers) is not an end;
 * - a hard ceiling, so the UI can never get stuck showing "Loading…".
 *
 * Clock/scheduler are injected so tests drive time explicitly.
 */
import type { Cancel, Clock, Scheduler } from '@/core/lib';

/** No incoming message for this long after `start()` ⇒ assume caught up. */
export const CATCH_UP_QUIET_MS = 1_500;
/** Catching up never lasts longer than this, no matter what. */
export const CATCH_UP_CEILING_MS = 20_000;
/**
 * The ceiling instead of `CATCH_UP_CEILING_MS` while a backend that reliably
 * sends `caughtUp` drains (see `start`): there the ceiling is only a safety
 * net. A queue built up over a long sleep can take minutes, and whatever is
 * left when a short ceiling ends would cycle through the sidebar's previews
 * and all notify.
 */
export const SIGNALLED_CATCH_UP_CEILING_MS = 120_000;

/** Why a run ended. `caughtUp` is whatever called `finish()` without a reason. */
export type CatchUpEndReason = 'caughtUp' | 'quiet' | 'ceiling';

/** Counts and flags only, for diagnostics; never anything about the messages. */
export interface CatchUpRunInfo {
  strict: boolean;
  /** Incoming messages seen during the run. */
  messages: number;
}

export interface CatchUpTrackerDeps {
  clock: Clock;
  scheduler: Scheduler;
  /** Called whenever `isCatchingUp` changes. */
  onChange: (catchingUp: boolean) => void;
  /** Called by every `start()`; `restarted` when a run was still going. */
  onStart?: (info: { strict: boolean; restarted: boolean }) => void;
  /** Called once when a run ends (not on `dispose()`). */
  onEnd?: (reason: CatchUpEndReason, info: CatchUpRunInfo) => void;
  /**
   * True while events are still waiting to be applied (in any queue). The
   * quiet period never ends while it is: silence from a stalled queue is not
   * quiet. The ceiling still bounds it.
   */
  isBusy?: () => boolean;
  quietMs?: number;
  ceilingMs?: number;
}

export interface CatchUpStartOptions {
  /** Ends only on `finish()` or the ceiling: no quiet period. */
  strict?: boolean;
}

export class CatchUpTracker {
  private catchingUp = false;
  private quietArmed = false;
  private quietTimer: Cancel | null = null;
  private ceilingTimer: Cancel | null = null;
  private strict = false;
  private messages = 0;
  /**
   * Bumped whenever the timers are cleared. A timer callback that was already
   * due when it was cancelled (or one scheduled before the machine slept and
   * run late on wake) sees a different value and does nothing, so it can never
   * end a run that started after it.
   */
  private generation = 0;

  constructor(private readonly deps: CatchUpTrackerDeps) {}

  get isCatchingUp(): boolean {
    return this.catchingUp;
  }

  /** Whether the current run has no quiet period (see `start`). */
  get isStrict(): boolean {
    return this.catchingUp && this.strict;
  }

  /**
   * Call on initial connect, and again after a reconnect following an offline
   * period. `ceilingMs` overrides this tracker's ceiling for this run only.
   */
  start(ceilingMs?: number, options: CatchUpStartOptions = {}): void {
    const restarted = this.catchingUp;
    this.clearTimers();
    this.strict = options.strict === true;
    this.messages = 0;
    const generation = this.generation;
    this.ceilingTimer = this.deps.scheduler.setTimeout(
      () => {
        if (generation !== this.generation) return;
        this.ceilingTimer = null;
        this.finish('ceiling');
      },
      ceilingMs ?? this.deps.ceilingMs ?? CATCH_UP_CEILING_MS,
    );
    this.setCatchingUp(true);
    this.deps.onStart?.({ strict: this.strict, restarted });
  }

  /**
   * Starts the quiet-period fallback. Call once messages can actually arrive
   * and be applied (after the initial sync): before that, silence means
   * "still connecting", not "caught up".
   */
  armQuiet(): void {
    if (!this.catchingUp || this.strict) return;
    this.quietArmed = true;
    this.scheduleQuiet();
  }

  /** Call for every incoming message event; restarts the quiet-period fallback. */
  onMessage(): void {
    if (!this.catchingUp) return;
    this.messages += 1;
    if (this.quietArmed) this.scheduleQuiet();
  }

  /** Call when the backend reports it has caught up (or the quiet/ceiling timers fire). */
  finish(reason: CatchUpEndReason = 'caughtUp'): void {
    const wasCatchingUp = this.catchingUp;
    const info = { strict: this.strict, messages: this.messages };
    this.clearTimers();
    this.setCatchingUp(false);
    if (wasCatchingUp) this.deps.onEnd?.(reason, info);
  }

  /** Stops the timers without notifying (teardown, e.g. SyncService.stop()). */
  dispose(): void {
    this.clearTimers();
    this.catchingUp = false;
  }

  private scheduleQuiet(): void {
    this.quietTimer?.();
    const generation = this.generation;
    this.quietTimer = this.deps.scheduler.setTimeout(() => {
      if (generation !== this.generation) return;
      this.quietTimer = null;
      if (this.deps.isBusy?.()) {
        this.scheduleQuiet();
        return;
      }
      this.finish('quiet');
    }, this.deps.quietMs ?? CATCH_UP_QUIET_MS);
  }

  private clearTimers(): void {
    this.generation += 1;
    this.quietArmed = false;
    this.quietTimer?.();
    this.ceilingTimer?.();
    this.quietTimer = null;
    this.ceilingTimer = null;
  }

  private setCatchingUp(value: boolean): void {
    if (this.catchingUp === value) return;
    this.catchingUp = value;
    this.deps.onChange(value);
  }
}
