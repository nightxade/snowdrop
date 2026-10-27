import { describe, expect, it } from 'vitest';
import { createBackfillGate } from './backfillGate';

const tick = () => Promise.resolve();

describe('backfillGate', () => {
  it('grants up to the limit at once and queues the rest in order', async () => {
    const gate = createBackfillGate(2);
    const [a, b, c, d] = [gate.acquire(), gate.acquire(), gate.acquire(), gate.acquire()] as const;
    const order: string[] = [];
    for (const [name, slot] of [
      ['a', a],
      ['b', b],
      ['c', c],
      ['d', d],
    ] as const)
      void slot.granted.then((ok) => {
        if (ok) order.push(name);
      });
    await tick();
    expect(order).toEqual(['a', 'b']);
    a.release();
    await tick();
    expect(order).toEqual(['a', 'b', 'c']);
    b.release();
    c.release();
    await tick();
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a queued request that is released never starts, and release is idempotent', async () => {
    const gate = createBackfillGate(1);
    const a = gate.acquire();
    const b = gate.acquire();
    const c = gate.acquire();
    b.release();
    b.release();
    await expect(b.granted).resolves.toBe(false);
    a.release();
    a.release();
    await expect(c.granted).resolves.toBe(true);
  });
});
