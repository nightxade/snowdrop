import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeDuplicate, messageId, type Message } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { IdbMessageRepository } from './IdbMessageRepository';
import { MemoryMessageRepository } from './MemoryMessageRepository';
import type { MessageRepository } from './MessageRepository';

const a = conversationIdFor('a');
const b = conversationIdFor('b');

/** Messages as a backend delivers them: no seq yet. */
const incoming = (partial: Partial<Message>): Message => {
  const { seq: _seq, ...m } = makeMessage(partial);
  return partial.seq === undefined ? m : { ...m, seq: partial.seq };
};

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
        incoming({
          conversationId: a,
          authorId: i % 2 ? 'x' : 'y',
          sentAt: i * 1000,
          body: `a${i}`,
        }),
      );
    }
    await repo.upsertMany(msgs, { backfill: false, merge: mergeDuplicate });
    await repo.upsert(
      incoming({ conversationId: b, authorId: 'x', sentAt: 15_500, body: 'b1' }),
      mergeDuplicate,
    );
  });

  afterEach(() => {
    repo.close?.();
  });

  it('assigns increasing seqs in arrival order', async () => {
    const page = await repo.page(a, { limit: 30 });
    expect(page.map((m) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect((await repo.get(messageId('x', 15_500)))?.seq).toBe(31);
  });

  it('orders by arrival, not by the sender clock', async () => {
    // A skewed sender: timestamp far in the past, but it arrived last.
    await repo.upsert(
      incoming({ conversationId: a, authorId: 'z', sentAt: 5, body: 'late' }),
      mergeDuplicate,
    );
    expect((await repo.latest(a))?.body).toBe('late');
  });

  it('pages before/after seq bounds in ascending order', async () => {
    expect((await repo.page(a, { limit: 5 })).map((m) => m.body)).toEqual([
      'a26',
      'a27',
      'a28',
      'a29',
      'a30',
    ]);
    expect((await repo.page(a, { limit: 5, before: 26 })).map((m) => m.body)).toEqual([
      'a21',
      'a22',
      'a23',
      'a24',
      'a25',
    ]);
    expect((await repo.page(a, { limit: 5, before: 3 })).map((m) => m.body)).toEqual(['a1', 'a2']);
    expect((await repo.page(a, { limit: 3, after: 10 })).map((m) => m.body)).toEqual([
      'a11',
      'a12',
      'a13',
    ]);
    expect((await repo.page(a, { limit: 3, after: 29 })).map((m) => m.body)).toEqual(['a30']);
    expect((await repo.page(b, { limit: 10 })).map((m) => m.body)).toEqual(['b1']);
  });

  it('backfills older history below existing seqs', async () => {
    const older = [
      incoming({ conversationId: a, authorId: 'x', sentAt: 1, body: 'old1' }),
      incoming({ conversationId: a, authorId: 'x', sentAt: 2, body: 'old2' }),
    ];
    await repo.upsertMany(older, { backfill: true, merge: mergeDuplicate });
    const first = await repo.page(a, { limit: 3, after: -Infinity });
    expect(first.map((m) => m.body)).toEqual(['old1', 'old2', 'a1']);
    // Later appends still go on top.
    await repo.upsert(
      incoming({ conversationId: a, authorId: 'x', sentAt: 99_000, body: 'new' }),
      mergeDuplicate,
    );
    expect((await repo.latest(a))?.body).toBe('new');
  });

  it('merges duplicates, keeping later events and the original seq', async () => {
    const id = messageId('x', 1000);
    await repo.update(id, (m) => ({ ...m, reactions: [{ emoji: '👍', authorId: 'y', at: 1 }] }));
    const result = await repo.upsert(
      incoming({ conversationId: a, authorId: 'x', sentAt: 1000, body: 'a1' }),
      mergeDuplicate,
    );
    expect(result.created).toBe(false);
    expect(result.message.reactions).toHaveLength(1);
    expect(result.message.seq).toBe(1);
    expect(await repo.count(a)).toBe(30);
  });

  it('honours reserved seqs and keeps seq on update', async () => {
    const seq = await repo.allocateSeq();
    expect(seq).toBe(32);
    await repo.upsert(
      incoming({ conversationId: a, authorId: 'me', sentAt: 1, body: 'reserved', seq }),
      mergeDuplicate,
    );
    expect((await repo.latest(a))?.body).toBe('reserved');
    const updated = await repo.update(messageId('me', 1), (m) => ({
      ...m,
      body: 'edited',
      seq: 999,
    }));
    expect(updated?.seq).toBe(32);
    expect(await repo.update(messageId('x', 999), (m) => m)).toBeUndefined();
  });

  it('lists messages after a cursor, counts and deletes', async () => {
    expect((await repo.listAfter(a, 28)).map((m) => m.body)).toEqual(['a29', 'a30']);
    expect(await repo.count(a)).toBe(30);
    await repo.delete(messageId('x', 1000));
    expect(await repo.count(a)).toBe(29);
  });

  it('searches bodies, newest first, optionally per conversation', async () => {
    await repo.upsert(
      incoming({ conversationId: b, authorId: 'y', sentAt: 77, body: 'Lunch at noon?' }),
      mergeDuplicate,
    );
    await repo.upsert(
      incoming({ conversationId: a, authorId: 'y', sentAt: 78, body: 'lunch was great' }),
      mergeDuplicate,
    );
    expect((await repo.search('LUNCH', { limit: 10 })).map((m) => m.body)).toEqual([
      'lunch was great',
      'Lunch at noon?',
    ]);
    expect((await repo.search('lunch noon', { limit: 10 })).map((m) => m.body)).toEqual([
      'Lunch at noon?',
    ]);
    expect(
      (await repo.search('lunch', { conversationId: b, limit: 10 })).map((m) => m.body),
    ).toEqual(['Lunch at noon?']);
    expect(await repo.search('  ', { limit: 10 })).toEqual([]);
  });

  it('finds mentions of a contact, newest first', async () => {
    const mention = (sentAt: number) =>
      incoming({
        conversationId: a,
        authorId: 'y',
        sentAt,
        body: '￼',
        ranges: [{ start: 0, length: 1, mentionId: 'me' }],
      });
    await repo.upsert(mention(500_000), mergeDuplicate);
    await repo.upsert(mention(600_000), mergeDuplicate);
    const found = await repo.mentions('me', { limit: 10 });
    expect(found.map((m) => m.sentAt)).toEqual([600_000, 500_000]);
    expect(found[0]).not.toHaveProperty('mentionIds');
    expect(await repo.mentions('me', { limit: 10, before: found[0]!.seq! })).toHaveLength(1);
  });

  it('lists expired messages', async () => {
    await repo.update(messageId('x', 1000), (m) => ({ ...m, expiresAt: 5_000 }));
    await repo.update(messageId('y', 2000), (m) => ({ ...m, expiresAt: 9_000 }));
    expect((await repo.expired(6_000, 10)).map((m) => m.body)).toEqual(['a1']);
  });

  it('stores the outbox, read cursors and clears everything', async () => {
    const input = { conversationId: a, body: 'x', ranges: [] };
    await repo.putOutbox({ nonce: 'n2', input, createdAt: 2 });
    await repo.putOutbox({ nonce: 'n1', input, createdAt: 1 });
    expect((await repo.listOutbox()).map((e) => e.nonce)).toEqual(['n1', 'n2']);
    await repo.deleteOutbox('n1');
    expect(await repo.listOutbox()).toHaveLength(1);

    await repo.setReadCursor(a, 10);
    await repo.setReadCursor(a, 12);
    expect(await repo.getReadCursors()).toEqual(new Map([[a, 12]]));
    await repo.clear();
    expect(await repo.count(a)).toBe(0);
    expect((await repo.getReadCursors()).size).toBe(0);
    expect(await repo.listOutbox()).toEqual([]);
    expect(await repo.allocateSeq()).toBe(1);
  });
});
