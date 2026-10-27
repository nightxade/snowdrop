/**
 * A small limit on how many "get it from your phone" requests are waiting
 * for an answer at once. Each request makes the phone re-upload the message's
 * attachments and show a notification, so someone clicking through a pile of
 * expired media must not fire them all at the same moment: the first few go
 * out immediately and the rest wait their turn, each starting as an earlier
 * one is answered, fails or times out.
 */
export const BACKFILL_MAX_OUTSTANDING = 3;

export interface BackfillSlot {
  /** Resolves `true` when it is this request's turn to be sent; `false` if released first. */
  granted: Promise<boolean>;
  /** Frees the slot (or leaves the queue). Safe to call any number of times. */
  release: () => void;
}

export interface BackfillGate {
  acquire: () => BackfillSlot;
}

export function createBackfillGate(max: number): BackfillGate {
  let active = 0;
  const waiting: Array<() => void> = [];

  const next = () => {
    while (active < max) {
      const start = waiting.shift();
      if (!start) return;
      start();
    }
  };

  return {
    acquire() {
      let state: 'queued' | 'held' | 'done' = 'queued';
      let settle: (ok: boolean) => void = () => undefined;
      const granted = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const start = () => {
        state = 'held';
        active += 1;
        settle(true);
      };
      if (active < max) start();
      else waiting.push(start);
      return {
        granted,
        release() {
          if (state === 'held') {
            state = 'done';
            active -= 1;
            next();
          } else if (state === 'queued') {
            state = 'done';
            const at = waiting.indexOf(start);
            if (at >= 0) waiting.splice(at, 1);
            settle(false);
          }
        },
      };
    },
  };
}

/** Shared by every attachment on screen: the limit is per app, not per tile. */
export const backfillGate = createBackfillGate(BACKFILL_MAX_OUTSTANDING);
