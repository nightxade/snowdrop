import { describe, expect, it } from 'vitest';
import { ReceiptBuffer } from './ReceiptBuffer';

describe('ReceiptBuffer', () => {
  it('holds a receipt until taken, keyed by sentAt', () => {
    const buffer = new ReceiptBuffer();
    buffer.hold(100, 'alice', 'delivered', 0);
    expect(buffer.size).toBe(1);
    expect(buffer.take(100, 0)).toMatchObject({
      status: 'delivered',
      recipients: { alice: { status: 'delivered', at: 0 } },
    });
    // Taken once: gone the second time.
    expect(buffer.take(100, 0)).toBeUndefined();
    expect(buffer.size).toBe(0);
  });

  it('advances the row-level status but tracks each recipient independently', () => {
    const buffer = new ReceiptBuffer();
    buffer.hold(100, 'alice', 'delivered', 0);
    buffer.hold(100, 'bob', 'read', 10);
    const held = buffer.take(100, 10);
    expect(held?.status).toBe('read');
    expect(held?.recipients).toEqual({
      alice: { status: 'delivered', at: 0 },
      bob: { status: 'read', at: 10 },
    });
  });

  it('drops an out-of-order "delivered" behind a recipient already "read"', () => {
    const buffer = new ReceiptBuffer();
    buffer.hold(100, 'alice', 'read', 0);
    buffer.hold(100, 'alice', 'delivered', 10);
    expect(buffer.take(100, 10)?.recipients).toEqual({ alice: { status: 'read', at: 0 } });
  });

  it('expires entries older than the ttl', () => {
    const buffer = new ReceiptBuffer(1_000);
    buffer.hold(100, 'alice', 'delivered', 0);
    expect(buffer.take(100, 999)).toBeDefined();
    buffer.hold(100, 'alice', 'delivered', 0);
    expect(buffer.take(100, 1_001)).toBeUndefined();
  });
});
