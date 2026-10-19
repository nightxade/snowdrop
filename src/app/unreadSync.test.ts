import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { UnreadSync } from './unreadSync';

describe('UnreadSync', () => {
  it('debounces bursts of notify() into a single compute()+send()', () => {
    const scheduler = new ManualScheduler();
    let computed = 0;
    const sent: { count: number; mentions: number }[] = [];
    const sync = new UnreadSync(
      scheduler,
      () => {
        computed += 1;
        return { count: 3, mentions: 0 };
      },
      (total) => sent.push(total),
      250,
    );

    sync.notify();
    sync.notify();
    sync.notify();
    expect(sent).toEqual([]); // nothing until the debounce fires.
    scheduler.advance(250);
    expect(computed).toBe(1);
    expect(sent).toEqual([{ count: 3, mentions: 0 }]);
  });

  it('skips the send when the computed total did not change', () => {
    const scheduler = new ManualScheduler();
    let count = 3;
    const sent: { count: number; mentions: number }[] = [];
    const sync = new UnreadSync(
      scheduler,
      () => ({ count, mentions: 0 }),
      (total) => sent.push(total),
      250,
    );

    sync.flush();
    expect(sent).toEqual([{ count: 3, mentions: 0 }]);

    // Same total again: notified, but nothing new is sent.
    sync.notify();
    scheduler.advance(250);
    expect(sent).toHaveLength(1);

    // A real change: sent again.
    count = 5;
    sync.notify();
    scheduler.advance(250);
    expect(sent).toEqual([
      { count: 3, mentions: 0 },
      { count: 5, mentions: 0 },
    ]);
  });

  it('flush() sends immediately regardless of any pending debounce', () => {
    const scheduler = new ManualScheduler();
    const sent: number[] = [];
    const sync = new UnreadSync(
      scheduler,
      () => ({ count: 1, mentions: 0 }),
      (total) => sent.push(total.count),
    );
    sync.flush();
    expect(sent).toEqual([1]);
  });

  it('dispose() cancels a pending debounce', () => {
    const scheduler = new ManualScheduler();
    const sent: number[] = [];
    const sync = new UnreadSync(
      scheduler,
      () => ({ count: 1, mentions: 0 }),
      (total) => sent.push(total.count),
      250,
    );
    sync.notify();
    sync.dispose();
    scheduler.advance(1_000);
    expect(sent).toEqual([]);
  });
});
