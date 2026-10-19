/**
 * Debounces and mirrors the frontend's total unread count to the desktop
 * shell (tray badge, taskbar/dock badge, window title —
 * src-tauri/src/tray.rs) via `desktopSetUnread` (src/app/platform.ts).
 * Pulled out of `createSnowdrop.ts` so the debounce/change-only logic is
 * unit-testable on its own, without booting a whole Snowdrop instance or
 * faking `isTauri()` (createSnowdrop.test.ts never runs inside Tauri, so
 * this code path is otherwise untested there — see docs/DESKTOP.md).
 */
import type { Cancel, Scheduler } from '@/core/lib';

export interface UnreadTotal {
  count: number;
  mentions: number;
}

/** ~250ms, per the brief: frequent enough to feel live, rare enough that a
 * burst of incoming messages (or a bulk mark-as-read) sends once. */
export const UNREAD_DEBOUNCE_MS = 250;

/**
 * Call `notify()` on every store change that might affect the total; it
 * coalesces bursts into a single `compute()` + `send()` roughly
 * `debounceMs` later, and skips the send entirely when the computed total
 * didn't actually change since the last one sent.
 */
export class UnreadSync {
  private pending: Cancel | null = null;
  private last: UnreadTotal | null = null;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly compute: () => UnreadTotal,
    private readonly send: (total: UnreadTotal) => void,
    private readonly debounceMs: number = UNREAD_DEBOUNCE_MS,
  ) {}

  /** Schedules a flush unless one's already pending (further calls before it fires are free). */
  notify(): void {
    if (this.pending) return;
    this.pending = this.scheduler.setTimeout(() => {
      this.pending = null;
      this.flush();
    }, this.debounceMs);
  }

  /** Computes now and sends immediately, but only if the total actually changed. */
  flush(): void {
    const total = this.compute();
    if (this.last && this.last.count === total.count && this.last.mentions === total.mentions) {
      return;
    }
    this.last = total;
    this.send(total);
  }

  /** Cancels a pending debounce (composition-root teardown); safe to call repeatedly. */
  dispose(): void {
    this.pending?.();
    this.pending = null;
  }
}
