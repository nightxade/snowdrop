import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messageId } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { IdbMessageRepository } from './IdbMessageRepository';
import { MemoryMessageRepository } from './MemoryMessageRepository';
import type { MessageRepository } from './MessageRepository';

const a = conversationIdFor('a');
const b = conversationIdFor('b');

let dbCounter = 0;
const implementations: [string, () => Promise<MessageRepository & { close?: () => void }>][] = [
  ['memory', () => Promise.resolve(new MemoryMessageRepository())],
  ['indexeddb', () => IdbMessageRepository.open(`hearth-test-${++dbCounter}`)],
];

describe.each(implementations)('MessageRepository (%s)', (_name, create) => {
  let repo: MessageRepository & { close?: () => void };

  beforeEach(async () => {
    repo = await create();
    const msgs = [];
    for (let i = 1; i <= 30; i++) {
      msgs.push(
        makeMessage({
          conversationId: a,
          authorId: i % 2 ? 'x' : 'y',
          sentAt: i * 1000,
          body: `a${i}`,
        }),
      );
    }
    msgs.push(makeMessage({ conversationId: b, authorId: 'x', sentAt: 15_500, body: 'b1' }));
    await repo.putMany(msgs);
  });

  afterEach(() => {
    repo.close?.();
  });

  it('gets by id and returns undefined for unknown ids', async () => {
    expect((await repo.get(messageId('y', 2000)))?.body).toBe('a2');
    expect(await repo.get(messageId('nope', 1))).toBeUndefined();
  });

  it('pages newest-first windows in ascending order, per conversation', async () => {
    const newest = await repo.page(a, { limit: 5 });
    expect(newest.map((m) => m.body)).toEqual(['a26', 'a27', 'a28', 'a29', 'a30']);
    const older = await repo.page(a, { limit: 5, before: 26_000 });
    expect(older.map((m) => m.body)).toEqual(['a21', 'a22', 'a23', 'a24', 'a25']);
    const tail = await repo.page(a, { limit: 5, before: 3000 });
    expect(tail.map((m) => m.body)).toEqual(['a1', 'a2']);
    expect((await repo.page(b, { limit: 10 })).map((m) => m.body)).toEqual(['b1']);
  });

  it('lists messages after a cursor and counts', async () => {
    expect((await repo.listAfter(a, 28_000)).map((m) => m.body)).toEqual(['a29', 'a30']);
    expect(await repo.count(a)).toBe(30);
    expect(await repo.count(b)).toBe(1);
  });

  it('updates atomically and strips client nonces', async () => {
    const id = messageId('x', 1000);
    const updated = await repo.update(id, (m) => ({ ...m, body: 'edited', nonce: 'n' }));
    expect(updated?.body).toBe('edited');
    expect(updated?.nonce).toBeUndefined();
    expect((await repo.get(id))?.body).toBe('edited');
    expect(await repo.update(messageId('x', 999), (m) => m)).toBeUndefined();
  });

  it('upserts on put and deletes', async () => {
    await repo.put(
      makeMessage({ conversationId: a, authorId: 'x', sentAt: 1000, body: 'replaced' }),
    );
    expect(await repo.count(a)).toBe(30);
    await repo.delete(messageId('x', 1000));
    expect(await repo.count(a)).toBe(29);
  });

  it('stores read cursors and clears everything', async () => {
    await repo.setReadCursor(a, 10_000);
    await repo.setReadCursor(a, 12_000);
    expect(await repo.getReadCursors()).toEqual(new Map([[a, 12_000]]));
    await repo.clear();
    expect(await repo.count(a)).toBe(0);
    expect((await repo.getReadCursors()).size).toBe(0);
  });
});
