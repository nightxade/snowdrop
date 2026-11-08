import { describe, expect, it } from 'vitest';
import { messageId, type Message } from '@/core/domain';
import { PendingOpsBuffer } from './PendingOpsBuffer';

const op =
  (tag: string) =>
  (m: Message): Message => ({ ...m, body: `${m.body}${tag}` });
const message = (id: string): Message =>
  ({ id, body: '', conversationId: 'c', authorId: 'a' }) as unknown as Message;

describe('PendingOpsBuffer', () => {
  it('evicts oldest first at the cap', () => {
    const buffer = new PendingOpsBuffer(3, 1000, 3);
    for (let i = 1; i <= 4; i += 1) buffer.hold(messageId(`a${i}`, i), op('x'), i);
    expect(buffer.size).toBe(3);
    expect(buffer.take(messageId('a1', 1), 5)).toHaveLength(0);
    expect(buffer.take(messageId('a4', 4), 5)).toHaveLength(1);
  });

  it("a burst on one author cannot evict other authors' early arrivals", () => {
    const buffer = new PendingOpsBuffer(6, 1000, 3);
    const early = messageId('genuine', 1);
    buffer.hold(early, op('y'), 1);
    for (let i = 0; i < 10; i += 1) buffer.hold(messageId('flood', 100 + i), op('x'), 2 + i);
    expect(buffer.take(early, 20)).toHaveLength(1);
    // The flooding author keeps only its newest three.
    expect(buffer.size).toBe(3);
    expect(buffer.take(messageId('flood', 100), 20)).toHaveLength(0);
    expect(buffer.take(messageId('flood', 109), 20)).toHaveLength(1);
  });

  it('applyTo applies and drains, and restore puts the operations back', () => {
    const buffer = new PendingOpsBuffer();
    const id = messageId('a', 1);
    buffer.hold(id, op('1'), 0);
    buffer.hold(id, op('2'), 1);
    const held = buffer.applyTo([message(id), message(messageId('a', 2))], 2);
    expect(held.messages.map((m) => m.body)).toEqual(['12', '']);
    expect(buffer.size).toBe(0);
    held.restore();
    expect(buffer.size).toBe(2);
    expect(buffer.take(id, 3).map((f) => f(message(id)).body)).toEqual(['1', '2']);
  });
});
