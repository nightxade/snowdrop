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
 *   (after the initial sync); `onMessage()` restarts it;
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
 * The ceiling for holding back notifications while a backend that reliably
 * sends `caughtUp` drains (see `start`). Much longer than the sidebar's: a
 * queue built up over a long sleep can take minutes, and what is left when the
 * short ceiling ends would otherwise all notify.
 */
export const NOTIFICATION_HOLD_CEILING_MS = 120_000;

export interface CatchUpTrackerDeps {
  clock: Clock;
  scheduler: Scheduler;
  /** Called whenever `isCatchingUp` changes. */
  onChange: (catchingUp: boolean) => void;
  quietMs?: number;
  ceilingMs?: number;
}

export class CatchUpTracker {
  private catchingUp = false;
  private quietArmed = false;
  private quietTimer: Cancel | null = null;
  private ceilingTimer: Cancel | null = null;

  constructor(private readonly deps: CatchUpTrackerDeps) {}

  get isCatchingUp(): boolean {
    return this.catchingUp;
  }

  /**
   * Call on initial connect, and again after a reconnect following an offline
   * period. `ceilingMs` overrides this tracker's ceiling for this run only.
   */
  start(ceilingMs?: number): void {
    this.clearTimers();
    this.ceilingTimer = this.deps.scheduler.setTimeout(
      () => {
        this.ceilingTimer = null;
        this.finish();
      },
      ceilingMs ?? this.deps.ceilingMs ?? CATCH_UP_CEILING_MS,
    );
    this.setCatchingUp(true);
  }

  /**
   * Starts the quiet-period fallback. Call once messages can actually arrive
   * and be applied (after the initial sync): before that, silence means
   * "still connecting", not "caught up".
   */
  armQuiet(): void {
    if (!this.catchingUp) return;
    this.quietArmed = true;
    this.scheduleQuiet();
  }

  /** Call for every incoming message event; restarts the quiet-period fallback. */
  onMessage(): void {
    if (this.catchingUp && this.quietArmed) this.scheduleQuiet();
  }

  /** Call when the backend reports it has caught up (or the quiet/ceiling timers fire). */
  finish(): void {
    this.clearTimers();
    this.setCatchingUp(false);
  }

  /** Stops the timers without notifying (teardown, e.g. SyncService.stop()). */
  dispose(): void {
    this.clearTimers();
    this.catchingUp = false;
  }

  private scheduleQuiet(): void {
    this.quietTimer?.();
    this.quietTimer = this.deps.scheduler.setTimeout(() => {
      this.quietTimer = null;
      this.finish();
    }, this.deps.quietMs ?? CATCH_UP_QUIET_MS);
  }

  private clearTimers(): void {
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
